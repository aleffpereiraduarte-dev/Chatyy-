/**
 * /reels-compose — publish a Reel. [2026-10-08 reels-publish]
 *
 * Flow: pick a video from the gallery OR record (existing /reels-recorder,
 * which saves a draft and hands the clips back) → looping preview (expo-video)
 * → trim (range ≤ 90 s, cut server-side by ffmpeg) → cover frame (chosen
 * instant, rendered server-side) → caption with #hashtags / @mentions →
 * audience (Todos / Seguidores / Amigos próximos) → allow comments →
 * "Publicar" hands everything to services/reelPublishQueue (background,
 * resumable upload with inline progress in the Reels tab) and closes.
 * "Salvar rascunho" persists clips + every compose field (services/reelDrafts);
 * opening a draft (?draft=<id>) resumes here.
 *
 * Black & white UI, SVG icons only, i18n via t() with local fallbacks.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  ScrollView,
  TextInput,
  Switch,
  Platform,
  PanResponder,
  ActivityIndicator,
  KeyboardAvoidingView,
  useWindowDimensions,
} from 'react-native';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useVideoPlayer, VideoView } from 'expo-video';
import Svg, { Path, Circle, Rect, Line } from 'react-native-svg';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { IconX, IconImage, IconCamera, IconCheck, IconVolume, IconVolumeX, IconGlobe, IconUsers, IconStar, IconFolder, IconPlay } from '../components/Icons';
import * as api from '../services/api';
import { getReelDraft, saveReelDraft } from '../services/reelDrafts';
import { enqueueReelPublish, REEL_MAX_MS } from '../services/reelPublishQueue';
import { haptic } from '../constants/theme';

const MIN_TRIM_MS = 1000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const FG = '#FFFFFF';
const FG2 = 'rgba(255,255,255,0.62)';
const FG3 = 'rgba(255,255,255,0.38)';
const LINE = 'rgba(255,255,255,0.14)';
const SURFACE = '#111111';
const SURFACE2 = '#1C1C1C';

function fmt(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Inline SVG glyphs not in Icons.js ──────────────────────────────────────
function IconScissors({ size = 18, color = FG }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx="6" cy="6" r="3" /><Circle cx="6" cy="18" r="3" />
      <Line x1="20" y1="4" x2="8.12" y2="15.88" /><Line x1="14.47" y1="14.48" x2="20" y2="20" /><Line x1="8.12" y1="8.12" x2="12" y2="12" />
    </Svg>
  );
}
function IconCover({ size = 18, color = FG }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="5" y="2" width="14" height="20" rx="2" /><Path d="M5 16l4-4 3 3 2-2 5 5" /><Circle cx="10" cy="8" r="1.5" />
    </Svg>
  );
}
function IconComment({ size = 18, color = FG }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </Svg>
  );
}

// ─── Timeline track: trim (2 handles) or cover (1 handle) ───────────────────
function TimelineTrack({ totalMs, start, end, cover, mode, frames, onChange, onScrub }) {
  const trackRef = useRef(null);
  const geo = useRef({ x: 0, w: 1 });
  const live = useRef({});
  live.current = { totalMs, start, end, cover, mode, onChange, onScrub };
  const dragRef = useRef(null); // 'start' | 'end' | 'cover'

  const measure = useCallback(() => {
    try {
      trackRef.current?.measureInWindow?.((x, y, w) => {
        if (w > 0) geo.current = { x, w };
      });
    } catch {}
  }, []);

  const msAt = (pageX) => {
    const { x, w } = geo.current;
    const f = Math.max(0, Math.min(1, (pageX - x) / Math.max(1, w)));
    return Math.round(f * (live.current.totalMs || 0));
  };

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      measure();
      const L = live.current;
      const ms = msAt(e.nativeEvent.pageX);
      if (L.mode === 'cover') {
        dragRef.current = 'cover';
      } else {
        dragRef.current = Math.abs(ms - L.start) <= Math.abs(ms - L.end) ? 'start' : 'end';
      }
      apply(ms, true);
    },
    onPanResponderMove: (e) => apply(msAt(e.nativeEvent.pageX), false),
    onPanResponderRelease: () => { live.current.onScrub?.(false); dragRef.current = null; },
    onPanResponderTerminate: () => { live.current.onScrub?.(false); dragRef.current = null; },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  function apply(ms, first) {
    const L = live.current;
    const which = dragRef.current;
    if (!which || !L.totalMs) return;
    if (first) L.onScrub?.(true);
    if (which === 'cover') {
      const c = Math.max(L.start, Math.min(L.end, ms));
      L.onChange?.({ cover: c }, c);
      return;
    }
    let s = L.start; let en = L.end;
    if (which === 'start') {
      s = Math.max(0, Math.min(ms, en - MIN_TRIM_MS));
      if (en - s > REEL_MAX_MS) en = s + REEL_MAX_MS;
    } else {
      en = Math.min(L.totalMs, Math.max(ms, s + MIN_TRIM_MS));
      if (en - s > REEL_MAX_MS) s = en - REEL_MAX_MS;
    }
    L.onChange?.({ start: s, end: en }, which === 'start' ? s : en);
  }

  const pct = (ms) => `${(totalMs > 0 ? (ms / totalMs) * 100 : 0).toFixed(3)}%`;
  return (
    <View
      ref={trackRef}
      onLayout={measure}
      style={styles.track}
      {...pan.panHandlers}
      accessibilityRole="adjustable"
      testID="reels-compose-track"
    >
      <View style={styles.trackFrames} pointerEvents="none">
        {frames && frames.length > 0 ? frames.map((f, i) => (
          <FrameThumb key={i} source={f} />
        )) : <View style={{ flex: 1, backgroundColor: SURFACE2 }} />}
      </View>
      {mode === 'trim' ? (
        <>
          <View pointerEvents="none" style={[styles.trackDim, { left: 0, width: pct(start) }]} />
          <View pointerEvents="none" style={[styles.trackDim, { left: pct(end), right: 0 }]} />
          <View pointerEvents="none" style={[styles.trackWindow, { left: pct(start), width: pct(end - start) }]} />
          <View pointerEvents="none" style={[styles.trackHandle, { left: pct(start), marginLeft: -7 }]}><View style={styles.trackHandleBar} /></View>
          <View pointerEvents="none" style={[styles.trackHandle, { left: pct(end), marginLeft: -7 }]}><View style={styles.trackHandleBar} /></View>
        </>
      ) : (
        <>
          <View pointerEvents="none" style={[styles.trackDim, { left: 0, width: pct(start) }]} />
          <View pointerEvents="none" style={[styles.trackDim, { left: pct(end), right: 0 }]} />
          <View pointerEvents="none" style={[styles.coverHandle, { left: pct(cover), marginLeft: -16 }]} />
        </>
      )}
    </View>
  );
}

function FrameThumb({ source }) {
  let ExpoImage = null;
  try { ExpoImage = require('expo-image').Image; } catch {}
  if (!ExpoImage) return <View style={{ flex: 1, backgroundColor: SURFACE2 }} />;
  return <ExpoImage source={source} style={{ flex: 1, height: '100%' }} contentFit="cover" />;
}

// ─── Screen ──────────────────────────────────────────────────────────────────
export default function ReelsComposeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const { t } = useLanguage();
  const { user } = useAuth();
  const tt = useCallback((k, fb, p) => {
    const v = t(k, p);
    if (v && v !== k) return v;
    let s = fb;
    if (p) Object.keys(p).forEach(x => { s = s.replace(new RegExp(`\\{${x}\\}`, 'g'), String(p[x])); });
    return s;
  }, [t]);

  // Media
  const [clips, setClips] = useState([]); // [{ uri, durationMs, name, type, size, file? }]
  const [music, setMusic] = useState(null);
  const [draftId, setDraftId] = useState(null);
  const [loadingDraft, setLoadingDraft] = useState(!!params?.draft);
  const [pickError, setPickError] = useState('');
  // Edit state (global ms across the clip sequence)
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [coverMs, setCoverMs] = useState(500);
  const [mode, setMode] = useState(null); // null | 'trim' | 'cover'
  const [autoTrimmed, setAutoTrimmed] = useState(false);
  const [frames, setFrames] = useState([]);
  // Post fields
  const [caption, setCaption] = useState('');
  const [audience, setAudience] = useState('everyone');
  const [allowComments, setAllowComments] = useState(true);
  const [tagged, setTagged] = useState([]); // [{ email, name }]
  const [suggest, setSuggest] = useState(null); // { kind:'@'|'#', q, items:[] }
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const dirtyRef = useRef(false);
  const restoredRef = useRef(null); // compose meta to apply once durations are known

  const totalMs = useMemo(() => clips.reduce((a, c) => a + (c.durationMs || 0), 0), [clips]);
  const offsets = useMemo(() => { let o = 0; return clips.map(c => { const v = o; o += c.durationMs || 0; return v; }); }, [clips]);
  const selMs = Math.max(0, trimEnd - trimStart);

  // ── Player ──
  const player = useVideoPlayer(null, (p) => {
    try { p.loop = false; p.timeUpdateEventInterval = 0.2; p.muted = false; } catch {}
  });
  const curIdxRef = useRef(0);
  const loadedUriRef = useRef(null);
  const userTrimmedRef = useRef(false); // user moved the trim handles / restored draft
  const liveRef = useRef({});
  liveRef.current = { clips, offsets, trimStart, trimEnd, mode, totalMs, paused };

  const loadClip = useCallback(async (idx, atSec = 0, play = true) => {
    const c = liveRef.current.clips[idx];
    if (!c?.uri || !player) return;
    try {
      if (curIdxRef.current !== idx || loadedUriRef.current !== c.uri) {
        curIdxRef.current = idx;
        loadedUriRef.current = c.uri;
        if (typeof player.replaceAsync === 'function') await player.replaceAsync({ uri: c.uri });
        else player.replace({ uri: c.uri });
      }
      try { player.currentTime = Math.max(0, atSec); } catch {}
      if (play) player.play(); else player.pause();
    } catch {}
  }, [player]);

  const seekGlobal = useCallback((ms, play) => {
    const L = liveRef.current;
    if (!L.clips.length) return;
    let idx = 0;
    for (let i = 0; i < L.clips.length; i++) { if (ms >= L.offsets[i]) idx = i; }
    loadClip(idx, (ms - L.offsets[idx]) / 1000, play);
  }, [loadClip]);

  // Load the first clip whenever the clip SET changes (not on duration updates).
  const clipKey = clips.map(c => c.uri).join('|');
  useEffect(() => {
    if (!clipKey) return;
    curIdxRef.current = -1;
    loadedUriRef.current = null;
    seekGlobal(liveRef.current.trimStart || 0, true);
  }, [clipKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { try { player.muted = muted; } catch {} }, [muted, player]);

  // Real durations from the player (picker / recorder values are estimates).
  useEffect(() => {
    if (!player) return undefined;
    const upd = () => {
      const d = Number(player.duration) || 0;
      const idx = curIdxRef.current;
      if (!(d > 0) || !isFinite(d) || idx < 0) return;
      setClips(prev => {
        const c = prev[idx];
        if (!c || Math.abs((c.durationMs || 0) - d * 1000) < 120) return prev;
        const next = prev.slice();
        next[idx] = { ...c, durationMs: Math.round(d * 1000) };
        return next;
      });
    };
    const s1 = player.addListener?.('statusChange', (e) => { if (e?.status === 'readyToPlay') upd(); });
    const s2 = player.addListener?.('sourceLoad', () => upd());
    return () => { try { s1?.remove?.(); s2?.remove?.(); } catch {} };
  }, [player]);

  // Loop inside [trimStart, trimEnd] across clips.
  useEffect(() => {
    if (!player) return undefined;
    const onTime = (e) => {
      const L = liveRef.current;
      if (L.mode === 'cover' || !L.clips.length) return;
      const g = (L.offsets[curIdxRef.current] || 0) + (Number(e?.currentTime) || 0) * 1000;
      if (L.trimEnd > 0 && g >= L.trimEnd - 40) seekGlobal(L.trimStart, !L.paused);
      else if (g < L.trimStart - 300) seekGlobal(L.trimStart, !L.paused);
    };
    const onEnd = () => {
      const L = liveRef.current;
      const i = curIdxRef.current;
      if (i + 1 < L.clips.length && L.offsets[i + 1] < L.trimEnd) loadClip(i + 1, 0, !L.paused);
      else seekGlobal(L.trimStart, !L.paused);
    };
    const a = player.addListener?.('timeUpdate', onTime);
    const b = player.addListener?.('playToEnd', onEnd);
    return () => { try { a?.remove?.(); b?.remove?.(); } catch {} };
  }, [player, seekGlobal, loadClip]);

  // Keep trim/cover consistent with the known total (and enforce ≤ 90 s).
  useEffect(() => {
    if (!totalMs) return;
    const r = restoredRef.current;
    if (r) {
      restoredRef.current = null;
      userTrimmedRef.current = (r.trimStartMs || 0) > 0 || (r.trimEndMs || 0) > 0;
      const s = Math.max(0, Math.min(r.trimStartMs || 0, totalMs - MIN_TRIM_MS));
      let e = r.trimEndMs > 0 ? Math.min(r.trimEndMs, totalMs) : totalMs;
      if (e - s > REEL_MAX_MS) e = s + REEL_MAX_MS;
      setTrimStart(s); setTrimEnd(e);
      setCoverMs(Math.max(s, Math.min(e, r.coverMs ?? s + 500)));
      return;
    }
    setTrimEnd(prev => {
      let e = (prev > 0 && userTrimmedRef.current) ? Math.min(prev, totalMs) : totalMs;
      if (e <= trimStart) e = totalMs;
      if (e - trimStart > REEL_MAX_MS) { e = trimStart + REEL_MAX_MS; setAutoTrimmed(true); }
      return e;
    });
    setCoverMs(c => Math.max(trimStart, Math.min(c, (trimEnd || totalMs))));
  }, [totalMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Native filmstrip (single clip) for the track background.
  useEffect(() => {
    setFrames([]);
    if (Platform.OS === 'web' || clips.length !== 1 || !totalMs) return undefined;
    let alive = true;
    let p2 = null;
    (async () => {
      try {
        const mod = require('expo-video');
        p2 = mod.createVideoPlayer({ uri: clips[0].uri });
        try { p2.muted = true; } catch {}
        const n = 8;
        const times = Array.from({ length: n }, (_, i) => ((totalMs / 1000) * (i + 0.5)) / n);
        const r = await Promise.race([
          p2.generateThumbnailsAsync(times, { maxWidth: 160, maxHeight: 284 }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
        ]);
        if (alive && Array.isArray(r)) setFrames(r);
      } catch {}
      finally { try { p2?.release?.(); } catch {} }
    })();
    return () => { alive = false; };
  }, [clips.length > 0 ? clips[0].uri : '', clips.length, totalMs > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load draft (?draft=id) ──
  const applyDraft = useCallback((d) => {
    if (!d) return;
    const cl = (d.clips || []).filter(c => c?.uri).map((c, i) => ({
      uri: c.uri, durationMs: c.durationMs || 0, name: c.name || `clip_${i}.mp4`, type: c.type || 'video/mp4', size: c.size || 0,
      file: (typeof Blob !== 'undefined' && c.file instanceof Blob) ? c.file : null,
    }));
    setClips(cl);
    setMusic(d.music || null);
    if (d.draftId || d.id) setDraftId(d.draftId || d.id);
    const cm = d.compose || null;
    if (cm) {
      setCaption(cm.caption || '');
      setAudience(cm.audience || 'everyone');
      setAllowComments(cm.allowComments !== false);
      setTagged(Array.isArray(cm.tagged) ? cm.tagged : []);
      restoredRef.current = { trimStartMs: cm.trimStartMs || 0, trimEndMs: cm.trimEndMs || 0, coverMs: cm.coverMs };
    } else {
      restoredRef.current = null;
      userTrimmedRef.current = false;
      setTrimStart(0); setTrimEnd(0); setCoverMs(500);
    }
    dirtyRef.current = !cm; // fresh recording = unsaved compose state
  }, []);

  useEffect(() => {
    const id = params?.draft ? String(params.draft) : '';
    if (!id) return;
    let alive = true;
    (async () => {
      // The recorder may have just handed this draft over in memory.
      let d = null;
      try {
        // eslint-disable-next-line no-undef
        const pend = globalThis.__pendingReelDraft;
        if (pend && (pend.draftId === id)) { d = pend; globalThis.__pendingReelDraft = null; } // eslint-disable-line no-undef
      } catch {}
      if (!d) d = await getReelDraft(id);
      if (alive) { if (d) applyDraft({ ...d, draftId: id }); setLoadingDraft(false); }
    })();
    return () => { alive = false; };
  }, [params?.draft]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coming back from /reels-recorder?from=compose or /reels-drafts?from=compose.
  useFocusEffect(useCallback(() => {
    try {
      // eslint-disable-next-line no-undef
      const pend = globalThis.__pendingReelDraft;
      if (pend && Array.isArray(pend.clips) && pend.clips.length) {
        globalThis.__pendingReelDraft = null; // eslint-disable-line no-undef
        applyDraft(pend);
      }
    } catch {}
    return () => { try { player.pause(); } catch {} };
  }, [applyDraft, player]));

  // ── Pick from gallery ──
  const pickGallery = useCallback(async () => {
    setPickError('');
    try { haptic.light(); } catch {}
    try {
      const ImagePicker = require('expo-image-picker');
      if (Platform.OS !== 'web') {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync?.();
        if (perm && perm.granted === false && perm.accessPrivileges !== 'limited') { setPickError(tt('reels.compose.permission', 'Permita o acesso à galeria para escolher um vídeo.')); return; }
      }
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], allowsMultipleSelection: false, quality: 1 });
      if (!res || res.canceled) return;
      const a = res.assets?.[0];
      if (!a?.uri) return;
      const size = a.fileSize || a.file?.size || 0;
      if (size > MAX_FILE_BYTES) { setPickError(tt('reels.compose.tooBig', 'Vídeo muito grande (máx. 200 MB).')); return; }
      // web: seconds; native: milliseconds.
      let dur = Number(a.duration) || 0;
      if (Platform.OS === 'web') dur = dur * 1000;
      const name = a.fileName || (a.file && a.file.name) || `reel_${Date.now()}.mp4`;
      restoredRef.current = null;
      userTrimmedRef.current = false;
      setTrimStart(0); setTrimEnd(0); setCoverMs(500); setAutoTrimmed(false);
      setClips([{ uri: a.uri, durationMs: Math.round(dur), name, type: a.mimeType || (a.file && a.file.type) || 'video/mp4', size, file: a.file || null }]);
      dirtyRef.current = true;
    } catch (e) {
      setPickError(tt('reels.compose.pickError', 'Não foi possível abrir este vídeo.'));
    }
  }, [tt]);

  const openRecorder = useCallback(() => {
    try { haptic.light(); } catch {}
    router.push('/reels-recorder?from=compose');
  }, [router]);

  // ── Caption: @mentions / #hashtags ──
  const trendingRef = useRef(null);
  const sugTimer = useRef(null);
  const onCaption = useCallback((txt) => {
    setCaption(txt);
    dirtyRef.current = true;
    if (sugTimer.current) clearTimeout(sugTimer.current);
    const at = /(^|\s)@([\wÀ-ɏ.]{1,30})$/.exec(txt);
    const hs = /(^|\s)#([\wÀ-ɏ]{0,40})$/.exec(txt);
    if (at) {
      const q = at[2];
      sugTimer.current = setTimeout(async () => {
        try {
          const r = await api.searchContacts(q);
          const items = (r?.contacts || []).filter(c => c?.email).slice(0, 8).map(c => ({ email: c.email, name: c.name || c.email }));
          setSuggest(items.length ? { kind: '@', q, items } : null);
        } catch { setSuggest(null); }
      }, 220);
    } else if (hs) {
      const q = (hs[2] || '').toLowerCase();
      sugTimer.current = setTimeout(async () => {
        try {
          if (!trendingRef.current) {
            const r = await api.chatFeedTrendingHashtags?.(30);
            const list = r?.data?.hashtags || r?.data?.tags || r?.hashtags || r?.tags || [];
            trendingRef.current = (Array.isArray(list) ? list : []).map(x => String(x?.hashtag || x?.tag || x || '').replace(/^#/, '')).filter(Boolean);
          }
          const items = trendingRef.current.filter(x => !q || x.toLowerCase().startsWith(q)).slice(0, 10).map(x => ({ tag: x }));
          setSuggest(items.length ? { kind: '#', q, items } : null);
        } catch { setSuggest(null); }
      }, 180);
    } else {
      setSuggest(null);
    }
  }, []);

  const applySuggestion = useCallback((it) => {
    setCaption(prev => {
      if (suggest?.kind === '@') {
        const handle = String(it.email).split('@')[0];
        return prev.replace(/(^|\s)@([\wÀ-ɏ.]{1,30})$/, `$1@${handle} `);
      }
      return prev.replace(/(^|\s)#([\wÀ-ɏ]{0,40})$/, `$1#${it.tag} `);
    });
    if (suggest?.kind === '@') {
      setTagged(prev => prev.some(p => p.email === it.email) ? prev : [...prev, { email: it.email, name: it.name }].slice(0, 30));
    }
    setSuggest(null);
  }, [suggest]);

  const hashtags = useMemo(() => {
    const out = [];
    const re = /#([\wÀ-ɏ]{1,40})/g;
    let m;
    while ((m = re.exec(caption)) && out.length < 30) if (!out.includes(m[1].toLowerCase())) out.push(m[1].toLowerCase());
    return out;
  }, [caption]);

  // ── Track interactions ──
  const onTrackChange = useCallback((patch, previewMs) => {
    dirtyRef.current = true;
    if (patch.start != null || patch.end != null) userTrimmedRef.current = true;
    if (patch.start != null) setTrimStart(patch.start);
    if (patch.end != null) setTrimEnd(patch.end);
    if (patch.cover != null) setCoverMs(patch.cover);
    if (patch.start != null || patch.end != null) {
      setCoverMs(c => Math.max(patch.start ?? trimStart, Math.min(c, patch.end ?? trimEnd)));
      setAutoTrimmed(false);
    }
    seekGlobal(previewMs, false);
  }, [seekGlobal, trimStart, trimEnd]);

  const onScrub = useCallback((active) => {
    if (active) { try { player.pause(); } catch {} return; }
    if (liveRef.current.mode === 'trim' && !liveRef.current.paused) seekGlobal(liveRef.current.trimStart, true);
  }, [player, seekGlobal]);

  const switchMode = useCallback((m) => {
    try { haptic.select(); } catch {}
    setMode(prev => {
      const next = prev === m ? null : m;
      if (next === 'cover') seekGlobal(coverMs, false);
      else if (!paused) seekGlobal(trimStart, true);
      return next;
    });
  }, [seekGlobal, coverMs, trimStart, paused]);

  const togglePlay = useCallback(() => {
    if (mode === 'cover') return;
    setPaused(p => {
      try { if (p) player.play(); else player.pause(); } catch {}
      return !p;
    });
  }, [player, mode]);

  // ── Save draft / publish ──
  const composeMeta = useCallback(() => ({
    caption: caption.trim(),
    audience,
    allowComments,
    coverMs,
    trimStartMs: trimStart,
    trimEndMs: trimEnd,
    tagged,
  }), [caption, audience, allowComments, coverMs, trimStart, trimEnd, tagged]);

  const saveDraft = useCallback(async (closeAfter = true) => {
    if (!clips.length || busy) return;
    setBusy(true);
    try {
      const rec = await saveReelDraft({ clips, music, totalDurationMs: totalMs, compose: composeMeta() }, draftId);
      if (rec?.id) setDraftId(rec.id);
      dirtyRef.current = false;
      try { haptic.success(); } catch {}
      setToast(tt('reels.compose.draftSaved', 'Rascunho salvo'));
      if (closeAfter) setTimeout(() => { try { if (router.canGoBack?.()) router.back(); else router.replace('/reels-drafts'); } catch {} }, 450);
    } finally { setBusy(false); }
  }, [clips, music, totalMs, composeMeta, draftId, busy, router, tt]);

  const publish = useCallback(async () => {
    if (!clips.length || busy || !user?.email) return;
    if (selMs > REEL_MAX_MS + 250) { setToast(tt('reels.compose.tooLong', 'Máximo de 90 segundos')); return; }
    setBusy(true);
    try { player.pause(); } catch {}
    try {
      const meta = composeMeta();
      const isFull = trimStart <= 0 && trimEnd >= totalMs - 250;
      await enqueueReelPublish({
        email: user.email,
        clips,
        draftId,
        meta: {
          ...meta,
          trimStartMs: isFull ? 0 : trimStart,
          trimEndMs: isFull ? 0 : trimEnd,
          durationMs: selMs,
          sound: music && music.id && music.id !== 'placeholder' ? { id: music.id, label: music.title || music.label || '' } : null,
          tagged: tagged.map(x => x.email),
        },
      });
      dirtyRef.current = false;
      try { haptic.success(); } catch {}
      try { if (router.canGoBack?.()) router.back(); else router.replace('/chat?tab=feed'); } catch { try { router.replace('/chat'); } catch {} }
    } catch {
      setToast(tt('reels.publish.failed', 'Falha ao publicar o reel'));
      setBusy(false);
    }
  }, [clips, busy, user, selMs, tt, player, composeMeta, trimStart, trimEnd, totalMs, draftId, music, tagged, router]);

  const requestClose = useCallback(() => {
    if (clips.length && dirtyRef.current) { setConfirmClose(true); return; }
    try { player.pause(); } catch {}
    try { if (router.canGoBack?.()) router.back(); else router.replace('/chat'); } catch {}
  }, [clips.length, router, player]);

  useEffect(() => { if (!toast) return undefined; const id = setTimeout(() => setToast(''), 2600); return () => clearTimeout(id); }, [toast]);

  // ── Layout ──
  const contentW = Math.min(winW, 560);
  const previewH = Math.max(260, Math.min(winH * 0.52, 560));
  const previewW = Math.round(previewH * 9 / 16);
  const hasMedia = clips.length > 0;
  const canPublish = hasMedia && !busy && selMs >= MIN_TRIM_MS - 1;

  const AUD = [
    { key: 'everyone', label: tt('reels.compose.audEveryone', 'Todos'), Icon: IconGlobe },
    { key: 'followers', label: tt('reels.compose.audFollowers', 'Seguidores'), Icon: IconUsers },
    { key: 'close_friends', label: tt('reels.compose.audClose', 'Amigos próximos'), Icon: IconStar },
  ];

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { width: contentW }]}>
        <TouchableOpacity onPress={requestClose} hitSlop={10} style={styles.hBtn} accessibilityRole="button" accessibilityLabel={tt('common.close', 'Fechar')}>
          <IconX size={22} color={FG} />
        </TouchableOpacity>
        <Text style={styles.hTitle}>{tt('reels.compose.title', 'Novo reel')}</Text>
        <TouchableOpacity onPress={() => router.push('/reels-drafts?from=compose')} hitSlop={10} style={styles.hBtnWide} accessibilityRole="button">
          <IconFolder size={18} color={FG} />
          <Text style={styles.hBtnTxt}>{tt('reels.compose.drafts', 'Rascunhos')}</Text>
        </TouchableOpacity>
      </View>

      {loadingDraft ? (
        <View style={styles.center}><ActivityIndicator color={FG} /></View>
      ) : !hasMedia ? (
        // ── Source picker ──
        <ScrollView contentContainerStyle={[styles.pickWrap, { width: contentW, alignSelf: 'center', paddingBottom: insets.bottom + 24 }]}>
          <Text style={styles.pickTitle}>{tt('reels.compose.pickTitle', 'Crie seu reel')}</Text>
          <Text style={styles.pickSub}>{tt('reels.compose.pickSub', 'Escolha um vídeo da galeria ou grave agora. Até 90 segundos.')}</Text>
          <Pressable onPress={pickGallery} style={({ pressed }) => [styles.pickCard, pressed && { opacity: 0.75 }]} accessibilityRole="button" testID="reels-compose-gallery">
            <View style={styles.pickIcon}><IconImage size={26} color="#000" /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.pickCardTitle}>{tt('reels.compose.gallery', 'Galeria')}</Text>
              <Text style={styles.pickCardSub}>{tt('reels.compose.gallerySub', 'Escolha um vídeo de até 90 s')}</Text>
            </View>
          </Pressable>
          <Pressable onPress={openRecorder} style={({ pressed }) => [styles.pickCard, pressed && { opacity: 0.75 }]} accessibilityRole="button">
            <View style={styles.pickIcon}><IconCamera size={26} color="#000" /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.pickCardTitle}>{tt('reels.compose.record', 'Gravar')}</Text>
              <Text style={styles.pickCardSub}>{tt('reels.compose.recordSub', 'Câmera com clipes, timer e música')}</Text>
            </View>
          </Pressable>
          {!!pickError && <Text style={styles.err}>{pickError}</Text>}
        </ScrollView>
      ) : (
        <KeyboardAvoidingView style={{ flex: 1, width: '100%' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ width: contentW, alignSelf: 'center', paddingBottom: 24 }}
            keyboardShouldPersistTaps="handled"
            scrollEnabled
          >
            {/* Preview */}
            <View style={{ alignItems: 'center', paddingTop: 4 }}>
              <Pressable onPress={togglePlay} style={[styles.preview, { width: previewW, height: previewH }]} accessibilityRole="button">
                <VideoView
                  player={player}
                  style={StyleSheet.absoluteFill}
                  contentFit="cover"
                  nativeControls={false}
                  allowsFullscreen={false}
                  allowsPictureInPicture={false}
                />
                {paused && mode !== 'cover' && (
                  <View style={styles.playBadge} pointerEvents="none"><IconPlay size={28} color="#000" /></View>
                )}
                <View style={styles.durBadge} pointerEvents="none">
                  <Text style={styles.durBadgeTxt}>{fmt(selMs)}{clips.length > 1 ? `  ·  ${tt('reels.compose.clips', '{count} clipes', { count: clips.length })}` : ''}</Text>
                </View>
                <TouchableOpacity onPress={() => setMuted(m => !m)} style={styles.muteBtn} hitSlop={8} accessibilityRole="button"
                  accessibilityLabel={muted ? tt('reels.compose.unmute', 'Ativar som') : tt('reels.compose.mute', 'Silenciar')}>
                  {muted ? <IconVolumeX size={16} color={FG} /> : <IconVolume size={16} color={FG} />}
                </TouchableOpacity>
                {mode === 'cover' && (
                  <View style={styles.coverTag} pointerEvents="none"><Text style={styles.coverTagTxt}>{tt('reels.compose.cover', 'Capa')}</Text></View>
                )}
              </Pressable>
            </View>

            {/* Tools */}
            <View style={styles.tools}>
              <ToolChip active={mode === 'trim'} onPress={() => switchMode('trim')} label={tt('reels.compose.trim', 'Cortar')} Icon={IconScissors} />
              <ToolChip active={mode === 'cover'} onPress={() => switchMode('cover')} label={tt('reels.compose.cover', 'Capa')} Icon={IconCover} />
              <ToolChip active={false} onPress={pickGallery} label={tt('reels.compose.change', 'Trocar')} Icon={IconImage} />
            </View>

            {mode && totalMs > 0 && (
              <View style={styles.editor}>
                <TimelineTrack
                  totalMs={totalMs}
                  start={trimStart}
                  end={trimEnd || totalMs}
                  cover={coverMs}
                  mode={mode}
                  frames={frames}
                  onChange={onTrackChange}
                  onScrub={onScrub}
                />
                <View style={styles.editorRow}>
                  <Text style={styles.editorTxt}>
                    {mode === 'trim'
                      ? `${fmt(trimStart)} – ${fmt(trimEnd)}  ·  ${tt('reels.compose.selected', '{seconds}s selecionados', { seconds: Math.round(selMs / 1000) })}`
                      : `${tt('reels.compose.coverAt', 'Capa em')} ${fmt(coverMs)}`}
                  </Text>
                </View>
                <Text style={styles.hint}>{mode === 'trim' ? tt('reels.compose.trimHint', 'Arraste as bordas para escolher o trecho (máx. 90 s)') : tt('reels.compose.coverHint', 'Arraste para escolher o quadro da capa')}</Text>
              </View>
            )}
            {autoTrimmed && (
              <Text style={styles.notice}>{tt('reels.compose.autoTrimmed', 'O vídeo passou de 90 s — mantivemos os primeiros 90 s. Ajuste em Cortar.')}</Text>
            )}

            {/* Caption */}
            <View style={styles.section}>
              <TextInput
                value={caption}
                onChangeText={onCaption}
                placeholder={tt('reels.compose.captionPlaceholder', 'Escreva uma legenda… use #hashtags e @menções')}
                placeholderTextColor={FG3}
                style={styles.caption}
                multiline
                maxLength={2200}
                testID="reels-compose-caption"
              />
              {suggest && suggest.items.length > 0 && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.sugRow}>
                  {suggest.items.map((it, i) => (
                    <TouchableOpacity key={i} onPress={() => applySuggestion(it)} style={styles.sugChip} accessibilityRole="button">
                      {suggest.kind === '@' ? (
                        <>
                          <View style={styles.sugAvatar}><Text style={styles.sugAvatarTxt}>{String(it.name || it.email).trim().charAt(0).toUpperCase()}</Text></View>
                          <Text style={styles.sugTxt} numberOfLines={1}>{it.name}</Text>
                        </>
                      ) : (
                        <Text style={styles.sugTxt}>#{it.tag}</Text>
                      )}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
              <View style={styles.capMeta}>
                <Text style={styles.capMetaTxt} numberOfLines={1}>
                  {hashtags.length ? hashtags.map(h => `#${h}`).join('  ') : ' '}
                </Text>
                <Text style={styles.capMetaTxt}>{caption.length}/2200</Text>
              </View>
              {tagged.length > 0 && (
                <View style={styles.taggedRow}>
                  {tagged.map(p => (
                    <TouchableOpacity key={p.email} onPress={() => setTagged(prev => prev.filter(x => x.email !== p.email))} style={styles.taggedChip} accessibilityRole="button">
                      <Text style={styles.taggedTxt} numberOfLines={1}>@{String(p.email).split('@')[0]}</Text>
                      <IconX size={12} color={FG2} />
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            {/* Audience */}
            <View style={styles.section}>
              <Text style={styles.label}>{tt('reels.compose.audience', 'Quem pode ver')}</Text>
              <View style={styles.segment}>
                {AUD.map(({ key, label, Icon }) => {
                  const on = audience === key;
                  return (
                    <TouchableOpacity key={key} onPress={() => { setAudience(key); dirtyRef.current = true; try { haptic.select(); } catch {} }}
                      style={[styles.segBtn, on && styles.segBtnOn]} accessibilityRole="radio" accessibilityState={{ selected: on }}>
                      <Icon size={15} color={on ? '#000' : FG2} />
                      <Text style={[styles.segTxt, on && styles.segTxtOn]} numberOfLines={1}>{label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {/* Comments */}
            <View style={[styles.section, styles.rowBetween]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                <IconComment size={18} color={FG} />
                <Text style={styles.rowTxt}>{tt('reels.compose.allowComments', 'Permitir comentários')}</Text>
              </View>
              <Switch
                value={allowComments}
                onValueChange={(v) => { setAllowComments(v); dirtyRef.current = true; }}
                trackColor={{ false: '#3A3A3A', true: '#FFFFFF' }}
                thumbColor={allowComments ? '#000000' : '#BDBDBD'}
                ios_backgroundColor="#3A3A3A"
                {...(Platform.OS === 'web' ? { activeThumbColor: '#000000' } : {})}
              />
            </View>
          </ScrollView>

          {/* Bottom bar */}
          <View style={[styles.bottom, { paddingBottom: Math.max(insets.bottom, 12) }]}>
            <View style={{ flexDirection: 'row', gap: 10, width: contentW, alignSelf: 'center', paddingHorizontal: 16 }}>
              <TouchableOpacity onPress={() => saveDraft(true)} disabled={busy} style={[styles.btnGhost, busy && { opacity: 0.5 }]} accessibilityRole="button" testID="reels-compose-save-draft">
                <Text style={styles.btnGhostTxt}>{tt('reels.compose.saveDraft', 'Salvar rascunho')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={publish} disabled={!canPublish} style={[styles.btnPrimary, !canPublish && { opacity: 0.45 }]} accessibilityRole="button" testID="reels-compose-publish">
                {busy ? <ActivityIndicator color="#000" /> : <Text style={styles.btnPrimaryTxt}>{tt('reels.compose.publish', 'Publicar')}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      )}

      {/* Discard confirm (same on every platform) */}
      {confirmClose && (
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{tt('reels.compose.discardTitle', 'Descartar reel?')}</Text>
            <Text style={styles.sheetBody}>{tt('reels.compose.discardBody', 'Você pode salvar como rascunho e continuar depois.')}</Text>
            <TouchableOpacity style={styles.sheetBtnPrimary} onPress={() => { setConfirmClose(false); saveDraft(true); }} accessibilityRole="button">
              <Text style={styles.btnPrimaryTxt}>{tt('reels.compose.saveDraft', 'Salvar rascunho')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetBtn} onPress={() => { setConfirmClose(false); dirtyRef.current = false; try { player.pause(); } catch {} try { if (router.canGoBack?.()) router.back(); else router.replace('/chat'); } catch {} }} accessibilityRole="button">
              <Text style={styles.sheetBtnTxt}>{tt('reels.compose.discard', 'Descartar')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.sheetBtn} onPress={() => setConfirmClose(false)} accessibilityRole="button">
              <Text style={[styles.sheetBtnTxt, { color: FG2 }]}>{tt('common.cancel', 'Cancelar')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {!!toast && (
        <View style={[styles.toast, { bottom: insets.bottom + 90 }]} pointerEvents="none">
          <IconCheck size={14} color="#000" />
          <Text style={styles.toastTxt}>{toast}</Text>
        </View>
      )}
    </View>
  );
}

function ToolChip({ active, onPress, label, Icon }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.tool, active && styles.toolOn]} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <Icon size={16} color={active ? '#000' : FG} />
      <Text style={[styles.toolTxt, active && { color: '#000' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, height: 52 },
  hBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  hBtnWide: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: 17, borderWidth: 1, borderColor: LINE },
  hBtnTxt: { color: FG, fontSize: 13, fontWeight: '600' },
  hTitle: { color: FG, fontSize: 17, fontWeight: '800', letterSpacing: 0.2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  pickWrap: { paddingHorizontal: 20, paddingTop: 28, gap: 14 },
  pickTitle: { color: FG, fontSize: 28, fontWeight: '800', letterSpacing: -0.4 },
  pickSub: { color: FG2, fontSize: 15, lineHeight: 21, marginBottom: 14 },
  pickCard: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 18, borderRadius: 18, backgroundColor: SURFACE, borderWidth: 1, borderColor: LINE },
  pickIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: FG, alignItems: 'center', justifyContent: 'center' },
  pickCardTitle: { color: FG, fontSize: 17, fontWeight: '700' },
  pickCardSub: { color: FG2, fontSize: 13, marginTop: 3 },
  err: { color: FG, fontSize: 13, textAlign: 'center', marginTop: 8, opacity: 0.85 },

  preview: { borderRadius: 18, overflow: 'hidden', backgroundColor: SURFACE, borderWidth: 1, borderColor: LINE },
  playBadge: { position: 'absolute', alignSelf: 'center', top: '45%', width: 56, height: 56, borderRadius: 28, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center', paddingLeft: 3 },
  durBadge: { position: 'absolute', left: 10, bottom: 10, backgroundColor: 'rgba(0,0,0,0.62)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  durBadgeTxt: { color: FG, fontSize: 12, fontWeight: '700' },
  muteBtn: { position: 'absolute', right: 10, top: 10, width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  coverTag: { position: 'absolute', left: 10, top: 10, backgroundColor: FG, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  coverTagTxt: { color: '#000', fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },

  tools: { flexDirection: 'row', justifyContent: 'center', gap: 10, marginTop: 14, paddingHorizontal: 16 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 36, borderRadius: 18, borderWidth: 1, borderColor: LINE, backgroundColor: SURFACE },
  toolOn: { backgroundColor: FG, borderColor: FG },
  toolTxt: { color: FG, fontSize: 13, fontWeight: '700' },

  editor: { marginTop: 14, paddingHorizontal: 16 },
  editorRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 10 },
  editorTxt: { color: FG, fontSize: 13, fontWeight: '700' },
  hint: { color: FG3, fontSize: 12, textAlign: 'center', marginTop: 4 },
  notice: { color: FG2, fontSize: 12, textAlign: 'center', marginTop: 10, paddingHorizontal: 24 },

  track: { height: 56, borderRadius: 10, overflow: 'visible', backgroundColor: SURFACE2, position: 'relative', ...(Platform.OS === 'web' ? { cursor: 'pointer', userSelect: 'none', touchAction: 'none' } : {}) },
  trackFrames: { ...StyleSheet.absoluteFillObject, flexDirection: 'row', borderRadius: 10, overflow: 'hidden' },
  trackDim: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.66)' },
  trackWindow: { position: 'absolute', top: -2, bottom: -2, borderWidth: 2, borderColor: FG, borderRadius: 8 },
  trackHandle: { position: 'absolute', top: -2, bottom: -2, width: 14, borderRadius: 4, backgroundColor: FG, alignItems: 'center', justifyContent: 'center' },
  trackHandleBar: { width: 2, height: 18, borderRadius: 1, backgroundColor: '#000' },
  coverHandle: { position: 'absolute', top: -6, bottom: -6, width: 32, borderRadius: 6, borderWidth: 3, borderColor: FG, backgroundColor: 'rgba(255,255,255,0.08)' },

  section: { marginTop: 18, marginHorizontal: 16, padding: 14, borderRadius: 16, backgroundColor: SURFACE, borderWidth: 1, borderColor: LINE },
  caption: { color: FG, fontSize: 15, lineHeight: 21, minHeight: 72, maxHeight: 180, textAlignVertical: 'top', padding: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) },
  sugRow: { gap: 8, paddingTop: 10 },
  sugChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 32, borderRadius: 16, backgroundColor: SURFACE2, borderWidth: 1, borderColor: LINE, maxWidth: 200 },
  sugAvatar: { width: 22, height: 22, borderRadius: 11, backgroundColor: FG, alignItems: 'center', justifyContent: 'center' },
  sugAvatarTxt: { color: '#000', fontSize: 11, fontWeight: '800' },
  sugTxt: { color: FG, fontSize: 13, fontWeight: '600' },
  capMeta: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginTop: 10 },
  capMetaTxt: { color: FG3, fontSize: 12, flexShrink: 1 },
  taggedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  taggedChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, height: 28, borderRadius: 14, borderWidth: 1, borderColor: LINE },
  taggedTxt: { color: FG, fontSize: 12, fontWeight: '600', maxWidth: 160 },

  label: { color: FG2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },
  segment: { flexDirection: 'row', gap: 6 },
  segBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 38, borderRadius: 12, borderWidth: 1, borderColor: LINE, paddingHorizontal: 6 },
  segBtnOn: { backgroundColor: FG, borderColor: FG },
  segTxt: { color: FG2, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  segTxtOn: { color: '#000' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTxt: { color: FG, fontSize: 15, fontWeight: '600' },

  bottom: { width: '100%', paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: LINE, backgroundColor: '#000' },
  btnGhost: { flex: 1, height: 50, borderRadius: 25, borderWidth: 1.5, borderColor: FG, alignItems: 'center', justifyContent: 'center' },
  btnGhostTxt: { color: FG, fontSize: 15, fontWeight: '700' },
  btnPrimary: { flex: 1.3, height: 50, borderRadius: 25, backgroundColor: FG, alignItems: 'center', justifyContent: 'center' },
  btnPrimaryTxt: { color: '#000', fontSize: 15, fontWeight: '800' },

  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'flex-end', padding: 16 },
  sheet: { width: '100%', maxWidth: 480, backgroundColor: SURFACE, borderRadius: 22, padding: 20, borderWidth: 1, borderColor: LINE, gap: 10, marginBottom: 12 },
  sheetTitle: { color: FG, fontSize: 18, fontWeight: '800' },
  sheetBody: { color: FG2, fontSize: 14, lineHeight: 20, marginBottom: 6 },
  sheetBtnPrimary: { height: 48, borderRadius: 24, backgroundColor: FG, alignItems: 'center', justifyContent: 'center' },
  sheetBtn: { height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  sheetBtnTxt: { color: FG, fontSize: 15, fontWeight: '700' },

  toast: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: FG, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9 },
  toastTxt: { color: '#000', fontSize: 13, fontWeight: '700' },
});
