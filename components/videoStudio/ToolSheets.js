// [2026-10-13 video-studio] Folhas do editor: Filtros, Legendas automáticas,
// Capa e Voz por cima (voiceover).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Platform, Alert } from 'react-native';
import { Image } from 'expo-image';
import { StudioSheet, Slider, Chip, C, PrimaryButton } from './ui';
import { FILTERS, FilterLayer } from './filters';
import { useSourceInfo, thumbAt } from './thumbs';
import { useClockValue } from './EdlPreview';
import { clipStarts, totalDuration, fmtTime, fmtTimePrecise } from '../../services/videoStudio/edlOps';
import { captions as fetchCaptions } from '../../services/videoStudio/studioApi';
import { uploadEdlAssets } from '../../services/videoStudio/renderQueue';

// ─── Filtros ────────────────────────────────────────────────────────────────
function FilterCard({ f, clip, on, onPress, label }) {
  const info = useSourceInfo(clip);
  const src = clip?.kind === 'image' ? { uri: clip.uri } : (thumbAt(info, (clip?.in || 0) + 0.3) || (clip?.thumb ? { uri: clip.thumb } : null));
  return (
    <TouchableOpacity onPress={onPress} style={styles.fCard} accessibilityRole="button" accessibilityState={{ selected: on }}>
      <View style={[styles.fThumb, on && styles.fThumbOn]}>
        {src ? <Image source={src} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
        <FilterLayer id={f.id} intensity={1} />
      </View>
      <Text style={[styles.fLabel, on && { color: '#fff', fontWeight: '800' }]} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

export function FiltersSheet({ visible, onClose, t, edl, onChange }) {
  const filter = edl?.filter || { id: 'none', intensity: 1 };
  const clip = edl?.clips?.[0];
  return (
    <StudioSheet visible={visible} onClose={onClose} title={t('studio.tool.filters')}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 10, paddingVertical: 6 }}>
        {FILTERS.map((f) => (
          <FilterCard key={f.id} f={f} clip={clip} on={filter.id === f.id} label={t(f.labelKey)}
            onPress={() => onChange({ id: f.id, intensity: f.id === filter.id ? filter.intensity : 1 })} />
        ))}
      </ScrollView>
      <View style={[styles.rowPad, { opacity: filter.id === 'none' ? 0.35 : 1 }]}>
        <Text style={styles.small}>{t('studio.filter.intensity')}</Text>
        <Slider value={filter.intensity ?? 1} disabled={filter.id === 'none'} onChange={(v) => onChange({ id: filter.id, intensity: Math.round(v * 100) / 100 })} style={{ flex: 1 }} />
        <Text style={styles.pct}>{Math.round((filter.intensity ?? 1) * 100)}</Text>
      </View>
      <Text style={styles.note}>{t('studio.filter.note')}</Text>
    </StudioSheet>
  );
}

// ─── Legendas automáticas ───────────────────────────────────────────────────
const CAP_STYLES = [
  { id: 'classic', labelKey: 'studio.captions.styleClassic' },
  { id: 'box', labelKey: 'studio.captions.styleBox' },
  { id: 'outline', labelKey: 'studio.captions.styleOutline' },
];

/** Segmentos (tempo-fonte por arquivo) → tempo da timeline, respeitando in/out/velocidade. */
export function mapCaptionsToTimeline(edl, byUri) {
  const starts = clipStarts(edl);
  const out = [];
  (edl.clips || []).forEach((c, i) => {
    const segs = byUri[c.uri] || [];
    const sp = c.speed || 1;
    segs.forEach((s) => {
      const a = Math.max(s.start, c.in);
      const b = Math.min(s.end, c.out);
      if (b - a < 0.05) return;
      out.push({ start: Math.round((starts[i] + (a - c.in) / sp) * 1000) / 1000, end: Math.round((starts[i] + (b - c.in) / sp) * 1000) / 1000, text: s.text });
    });
  });
  return out.sort((x, y) => x.start - y.start);
}

export function CaptionsSheet({ visible, onClose, t, edl, email, lang, onApply, onSeek }) {
  const cap = edl?.captions || {};
  const [segments, setSegments] = useState(cap.segments || []);
  const [enabled, setEnabled] = useState(!!cap.enabled);
  const [style, setStyle] = useState(cap.style || 'classic');
  const [busy, setBusy] = useState(null); // null | {phase, pct}
  const [err, setErr] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => {
    if (!visible) return;
    setSegments(edl?.captions?.segments || []);
    setEnabled(!!edl?.captions?.enabled);
    setStyle(edl?.captions?.style || 'classic');
    setErr(null);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { try { abortRef.current?.abort(); } catch {} }, []);

  const generate = useCallback(async () => {
    setErr(null);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    abortRef.current = ctrl;
    setBusy({ phase: 'upload', pct: 0 });
    const uris = [...new Set((edl.clips || []).filter((c) => c.kind !== 'image').map((c) => c.uri))];
    if (!uris.length) { setBusy(null); setErr('noVideo'); return; }
    const up = await uploadEdlAssets(edl, email, { onlyUris: uris, signal: ctrl?.signal, onProgress: (f) => setBusy({ phase: 'upload', pct: f }) });
    if (!up.ok) { setBusy(null); setErr(up.aborted ? null : 'upload'); return; }
    setBusy({ phase: 'transcribe', pct: 0 });
    const byUri = {};
    for (const u of uris) {
      const remote = up.map[u] || u;
      // eslint-disable-next-line no-await-in-loop
      const r = await fetchCaptions({ mediaUrl: remote, lang: lang || 'pt' });
      if (!r.ok) { setBusy(null); setErr(r.missing ? 'missing' : 'transcribe'); return; }
      byUri[u] = r.segments;
    }
    const segs = mapCaptionsToTimeline(edl, byUri);
    setSegments(segs);
    setEnabled(true);
    setBusy(null);
    if (!segs.length) setErr('empty');
  }, [edl, email, lang]);

  const apply = () => onApply({ ...(edl.captions || {}), enabled: enabled && segments.length > 0, style, lang: lang || edl.captions?.lang || 'pt', segments: segments.filter((s) => s.text.trim()) });

  const errMsg = err === 'missing' ? t('studio.captions.unavailable') : err === 'upload' ? t('studio.captions.uploadFailed') : err === 'empty' ? t('studio.captions.empty') : err === 'noVideo' ? t('studio.captions.noVideo') : err ? t('studio.captions.failed') : null;
  return (
    <StudioSheet visible={visible} onClose={onClose} title={t('studio.tool.captions')} full avoidKeyboard
      right={<TouchableOpacity onPress={apply} hitSlop={10} accessibilityRole="button"><Text style={styles.done}>{t('studio.done')}</Text></TouchableOpacity>}>
      <View style={styles.capTop}>
        {busy ? (
          <View style={styles.busy}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.small}>{busy.phase === 'upload' ? t('studio.captions.uploading', { pct: Math.round(busy.pct * 100) }) : t('studio.captions.transcribing')}</Text>
          </View>
        ) : (
          <PrimaryButton label={segments.length ? t('studio.captions.regenerate') : t('studio.captions.generate')} onPress={generate} dark={segments.length > 0} />
        )}
        {!!errMsg && <Text style={styles.err}>{errMsg}</Text>}
        {segments.length > 0 && (
          <View style={styles.capOpts}>
            <Chip label={enabled ? t('studio.captions.on') : t('studio.captions.off')} on={enabled} onPress={() => setEnabled((v) => !v)} />
            {CAP_STYLES.map((s) => <Chip key={s.id} label={t(s.labelKey)} on={style === s.id} onPress={() => setStyle(s.id)} />)}
          </View>
        )}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 20 }} keyboardShouldPersistTaps="handled">
        {segments.map((s, i) => (
          <View key={`${i}_${s.start}`} style={styles.segRow}>
            <TouchableOpacity onPress={() => onSeek?.(s.start + 0.01)} style={styles.segTime} accessibilityRole="button">
              <Text style={styles.segTimeTxt}>{fmtTimePrecise(s.start)}</Text>
            </TouchableOpacity>
            <TextInput
              value={s.text}
              onChangeText={(v) => setSegments((arr) => arr.map((x, k) => (k === i ? { ...x, text: v } : x)))}
              style={styles.segInput}
              multiline
              placeholderTextColor={C.fg3}
            />
            <TouchableOpacity onPress={() => setSegments((arr) => arr.filter((_, k) => k !== i))} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('studio.delete')}>
              <Text style={styles.segDel}>{t('studio.delete')}</Text>
            </TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </StudioSheet>
  );
}

// ─── Capa ───────────────────────────────────────────────────────────────────
export function CoverSheet({ visible, onClose, t, edl, onApply, onSeek }) {
  const total = totalDuration(edl);
  const [ct, setCt] = useState(edl?.cover?.t || 0);
  const [text, setText] = useState(edl?.cover?.text || '');
  useEffect(() => {
    if (!visible) return;
    setCt(Math.min(edl?.cover?.t || 0, Math.max(0, total - 0.05)));
    setText(edl?.cover?.text || '');
    onSeek?.(edl?.cover?.t || 0);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const throttle = useRef(0);
  const change = (v) => {
    const tt = v * Math.max(0.05, total - 0.05);
    setCt(tt);
    const now = Date.now();
    if (now - throttle.current > 80) { throttle.current = now; onSeek?.(tt); }
  };
  return (
    <StudioSheet visible={visible} onClose={onClose} title={t('studio.tool.cover')} avoidKeyboard
      right={<TouchableOpacity onPress={() => onApply({ t: Math.round(ct * 1000) / 1000, text: text.trim() })} hitSlop={10} accessibilityRole="button"><Text style={styles.done}>{t('studio.done')}</Text></TouchableOpacity>}>
      <View style={{ paddingHorizontal: 14, gap: 8 }}>
        <Text style={styles.small}>{t('studio.cover.pick')}</Text>
        <CoverStrip edl={edl} />
        <Slider value={total > 0 ? ct / Math.max(0.05, total - 0.05) : 0} onChange={change} onEnd={(v) => { change(v); onSeek?.(v * Math.max(0.05, total - 0.05)); }} />
        <Text style={[styles.small, { textAlign: 'center' }]}>{fmtTimePrecise(ct)}</Text>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={t('studio.cover.textPlaceholder')}
          placeholderTextColor={C.fg3}
          style={styles.coverInput}
          maxLength={80}
        />
        <Text style={styles.note}>{t('studio.cover.note')}</Text>
      </View>
    </StudioSheet>
  );
}
function CoverStrip({ edl }) {
  const clips = edl?.clips || [];
  const n = 8;
  const total = totalDuration(edl);
  const starts = clipStarts(edl);
  const cells = [];
  for (let k = 0; k < n; k++) {
    const tt = ((k + 0.5) / n) * total;
    let idx = 0;
    for (let i = 0; i < clips.length; i++) if (tt >= starts[i]) idx = i;
    const c = clips[idx];
    if (!c) continue;
    cells.push(<CoverCell key={k} clip={c} src={c.in + (tt - starts[idx]) * (c.speed || 1)} />);
  }
  return <View style={styles.strip}>{cells}</View>;
}
function CoverCell({ clip, src }) {
  const info = useSourceInfo(clip);
  const s = clip.kind === 'image' ? { uri: clip.uri } : (thumbAt(info, src) || (clip.thumb ? { uri: clip.thumb } : null));
  return <View style={styles.stripCell}>{s ? <Image source={s} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}</View>;
}

// ─── Voz por cima ───────────────────────────────────────────────────────────
function RecorderPanel({ t, edl, clock, preview, onRecorded, onBusy }) {
  const A = useMemo(() => { try { return require('expo-audio'); } catch { return null; } }, []);
  const recorder = A?.useAudioRecorder ? A.useAudioRecorder(A.RecordingPresets.HIGH_QUALITY) : null; // eslint-disable-line react-hooks/rules-of-hooks
  const [state, setState] = useState('idle'); // idle | recording | saving
  const total = totalDuration(edl);
  const tNow = useClockValue(clock, (x) => Math.floor(x * 10) / 10, 6);
  const stoppingRef = useRef(false);

  const stop = useCallback(async () => {
    if (!recorder || stoppingRef.current) return;
    stoppingRef.current = true;
    setState('saving');
    try { preview.current?.pause(); } catch {}
    let uri = null;
    try { await recorder.stop(); uri = recorder.uri; } catch {}
    try { await A.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }); } catch {}
    stoppingRef.current = false;
    setState('idle');
    onBusy?.(false);
    if (uri) onRecorded(uri);
  }, [recorder, A, preview, onRecorded, onBusy]);

  useEffect(() => {
    if (state !== 'recording') return;
    if (tNow >= total - 0.12) stop();
  }, [tNow, state, total, stop]);

  const start = useCallback(async () => {
    if (!recorder || !A) { Alert.alert(t('studio.voice.title'), t('studio.voice.unavailable')); return; }
    // [2026-10-20 call-audio-guard] narração grava → bloqueada com ligação ativa
    try { if (require('../../services/callAudioGuard').blockIfCall('record')) return; } catch {}
    try {
      const perm = await A.requestRecordingPermissionsAsync();
      if (!perm?.granted) { Alert.alert(t('studio.voice.title'), t('studio.voice.micDenied')); return; }
      await A.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      onBusy?.(true);
      await preview.current?.seek(0);
      recorder.record();
      await preview.current?.play();
      setState('recording');
    } catch (e) {
      onBusy?.(false);
      Alert.alert(t('studio.voice.title'), t('studio.voice.failed'));
    }
  }, [recorder, A, preview, t, onBusy]);

  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => () => {
    if (stateRef.current === 'recording') {
      try { recorder?.stop(); } catch {}
      try { A?.setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }); } catch {}
      onBusy?.(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={{ alignItems: 'center', gap: 10, paddingVertical: 8 }}>
      <Text style={styles.small}>{state === 'recording' ? `${fmtTime(tNow)} / ${fmtTime(total)}` : t('studio.voice.hint')}</Text>
      <TouchableOpacity
        onPress={state === 'recording' ? stop : start}
        disabled={state === 'saving'}
        style={[styles.recBtn, state === 'recording' && styles.recBtnOn]}
        accessibilityRole="button"
        accessibilityLabel={state === 'recording' ? t('studio.voice.stop') : t('studio.voice.record')}
      >
        {state === 'saving' ? <ActivityIndicator color="#000" /> : <View style={state === 'recording' ? styles.recSquare : styles.recDot} />}
      </TouchableOpacity>
      <Text style={styles.small}>{state === 'recording' ? t('studio.voice.stop') : t('studio.voice.record')}</Text>
    </View>
  );
}

export function VoiceSheet({ visible, onClose, t, edl, clock, preview, onRecorded, onRemove, onVolume, onBusy }) {
  const vo = edl?.audio?.voiceover;
  const [busy, setBusy] = useState(false);
  return (
    <StudioSheet visible={visible} onClose={() => { if (!busy) onClose(); }} title={t('studio.voice.title')}>
      <View style={{ paddingHorizontal: 14, gap: 6 }}>
        {Platform.OS === 'web' ? (
          <Text style={styles.note}>{t('studio.voice.unavailable')}</Text>
        ) : (
          visible ? <RecorderPanel t={t} edl={edl} clock={clock} preview={preview} onRecorded={onRecorded} onBusy={(b) => { setBusy(b); onBusy?.(b); }} /> : null
        )}
        {!!vo && !busy && (
          <>
            <View style={styles.rowPad0}>
              <Text style={styles.small}>{t('studio.voice.volume')}</Text>
              <Slider value={vo.volume ?? 1} onChange={(v) => onVolume(Math.round(v * 100) / 100)} style={{ flex: 1 }} />
              <Text style={styles.pct}>{Math.round((vo.volume ?? 1) * 100)}</Text>
            </View>
            <TouchableOpacity onPress={onRemove} style={{ alignSelf: 'center', padding: 8 }} accessibilityRole="button">
              <Text style={styles.segDel}>{t('studio.voice.remove')}</Text>
            </TouchableOpacity>
          </>
        )}
        <Text style={styles.note}>{t('studio.voice.headphones')}</Text>
      </View>
    </StudioSheet>
  );
}

const styles = StyleSheet.create({
  done: { color: '#fff', fontWeight: '800', fontSize: 15 },
  small: { color: C.fg2, fontSize: 12 },
  note: { color: C.fg3, fontSize: 11, paddingHorizontal: 14, paddingVertical: 8, lineHeight: 15 },
  pct: { color: C.fg2, fontSize: 12, width: 28, textAlign: 'right' },
  rowPad: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, marginTop: 6 },
  rowPad0: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  fCard: { width: 66, alignItems: 'center', gap: 6 },
  fThumb: { width: 62, height: 84, borderRadius: 10, overflow: 'hidden', backgroundColor: '#222', borderWidth: 2, borderColor: 'transparent' },
  fThumbOn: { borderColor: '#fff' },
  fLabel: { color: C.fg2, fontSize: 11 },
  capTop: { paddingHorizontal: 14, gap: 10, paddingBottom: 8 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 46, justifyContent: 'center' },
  err: { color: '#fff', fontSize: 12, backgroundColor: 'rgba(255,255,255,0.08)', padding: 10, borderRadius: 10, overflow: 'hidden' },
  capOpts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  segRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  segTime: { paddingTop: 6, width: 52 },
  segTimeTxt: { color: C.fg3, fontSize: 11, fontVariant: ['tabular-nums'] },
  segInput: { flex: 1, color: '#fff', fontSize: 14, paddingVertical: 4, minHeight: 30 },
  segDel: { color: C.fg2, fontSize: 12, fontWeight: '700', paddingTop: 6 },
  strip: { flexDirection: 'row', height: 64, borderRadius: 8, overflow: 'hidden', backgroundColor: '#1a1a1a' },
  stripCell: { flex: 1, backgroundColor: '#222' },
  coverInput: { height: 42, borderRadius: 12, backgroundColor: C.card, color: '#fff', paddingHorizontal: 12, fontSize: 15 },
  recBtn: { width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  recBtnOn: { backgroundColor: '#fff' },
  recDot: { width: 52, height: 52, borderRadius: 26, backgroundColor: '#fff' },
  recSquare: { width: 24, height: 24, borderRadius: 4, backgroundColor: '#000' },
});
