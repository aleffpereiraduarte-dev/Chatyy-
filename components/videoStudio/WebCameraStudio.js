// [2026-10-13 video-studio] Câmera de criação — WEB (versão simples).
// getUserMedia + MediaRecorder, um segmento por vez (tocar p/ gravar, tocar p/ parar), virar câmera,
// velocidade por trecho, filtros (CSS fiel no preview), limite 15 s/60 s/3 min, apagar último, importar arquivo.
// Segmentos web são blob: URLs (vivem só nesta aba) — o editor/servidor sobe o blob ao publicar.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { IconX, IconCameraFlip, IconSparkles, IconImage, IconUndo2, IconCheck, IconMusic } from '../Icons';
import { SPEEDS } from '../../services/videoStudio/edl';
import { STUDIO_FILTERS, getStudioFilter } from '../../services/videoStudio/filters';
import { useSegmentSession, LIMITS_S, assetsToClips, probeVideo } from '../../services/videoStudio/useSegmentSession';

const fmt = (s) => { const x = Math.max(0, Math.floor(s)); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
const limitLabel = (s) => (s >= 60 ? `${s / 60} min` : `${s}s`);

function pickMime() {
  try {
    const MR = typeof window !== 'undefined' ? window.MediaRecorder : null;
    if (!MR || !MR.isTypeSupported) return '';
    const c = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return c.find((m) => MR.isTypeSupported(m)) || '';
  } catch { return ''; }
}

export default function WebCameraStudio({ t, draftId, initialMusic, onNext, onClose }) {
  const isFocused = useIsFocused();
  const session = useSegmentSession({ draftId, initialMusic });
  const { segments, totalS, limitS, setLimitS, filter, setFilter, music, setMusic } = session;

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recRef = useRef(null);
  const chunksRef = useRef([]);
  const startRef = useRef(0);
  const audioRef = useRef(null);
  const [facing, setFacing] = useState('user');
  const [status, setStatus] = useState('init'); // init | ready | denied | unsupported
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [panel, setPanel] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const stopStream = useCallback(() => {
    try { streamRef.current?.getTracks?.().forEach((tr) => tr.stop()); } catch {}
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!isFocused) { stopStream(); return undefined; }
    session.reloadFromStore();
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
    if (!md?.getUserMedia || typeof window === 'undefined' || !window.MediaRecorder) { setStatus('unsupported'); return undefined; }
    let alive = true;
    md.getUserMedia({ video: { facingMode: facing, width: { ideal: 1080 }, height: { ideal: 1920 } }, audio: true })
      .then((stream) => {
        if (!alive) { stream.getTracks().forEach((tr) => tr.stop()); return; }
        stopStream();
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play?.().catch(() => {}); }
        setStatus('ready');
      })
      .catch(() => { if (alive) setStatus('denied'); });
    return () => { alive = false; };
  }, [facing, isFocused, stopStream]);

  useEffect(() => () => { try { recRef.current?.state === 'recording' && recRef.current.stop(); } catch {} stopStream(); try { audioRef.current?.pause(); } catch {} }, [stopStream]);

  // Música (hook do editor/servidor) — toca durante a gravação.
  useEffect(() => {
    if (!music?.url || typeof window === 'undefined' || !window.Audio) { audioRef.current = null; return undefined; }
    const a = new window.Audio(music.url);
    a.preload = 'auto';
    audioRef.current = a;
    return () => { try { a.pause(); } catch {} };
  }, [music?.url]);

  useEffect(() => {
    if (!recording) return undefined;
    const iv = setInterval(() => {
      const ms = Date.now() - startRef.current;
      setElapsed(ms);
      if (totalS + ms / 1000 / speed >= limitS - 0.05) stop();
    }, 60);
    return () => clearInterval(iv);
  }, [recording, totalS, speed, limitS]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(() => {
    if (!streamRef.current || recording) return;
    if (limitS - totalS < 0.3) { setErr(t('videoStudio.cam.limitReached')); return; }
    setErr(null);
    const mime = pickMime();
    let rec;
    try { rec = new window.MediaRecorder(streamRef.current, mime ? { mimeType: mime } : undefined); } catch { setErr(t('videoStudio.cam.recordFailed')); return; }
    chunksRef.current = [];
    const spd = speed;
    const fac = facing;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    rec.onstop = async () => {
      const wall = (Date.now() - startRef.current) / 1000;
      setRecording(false); setElapsed(0);
      try { audioRef.current?.pause(); } catch {}
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || mime || 'video/webm' });
      if (!blob.size) { setErr(t('videoStudio.cam.recordFailed')); return; }
      const uri = URL.createObjectURL(blob);
      const out = Math.max(0.1, Math.min(wall, (limitS - totalS) * spd));
      await session.addSegment({ uri, kind: 'video', in: 0, out, speed: spd, mirror: fac === 'user', camera: fac === 'user' ? 'front' : 'back' });
    };
    recRef.current = rec;
    startRef.current = Date.now();
    rec.start(250);
    setRecording(true);
    setPanel(null);
    const a = audioRef.current;
    if (a && music) {
      try { a.currentTime = (Number(music.start) || 0) + totalS; a.playbackRate = Math.max(0.5, Math.min(2, 1 / spd)); a.play().catch(() => {}); } catch {}
    }
  }, [recording, limitS, totalS, speed, facing, session, music, t]);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec || rec.state !== 'recording') return;
    const age = Date.now() - startRef.current;
    if (age < 500) { setTimeout(() => { try { rec.state === 'recording' && rec.stop(); } catch {} }, 500 - age); return; }
    try { rec.stop(); } catch {}
  }, []);

  const importFile = useCallback(async () => {
    if (recording || busy) return;
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos', 'images'], allowsMultipleSelection: true, selectionLimit: 20, quality: 1 });
      if (res?.canceled || !res?.assets?.length) return;
      setBusy('import');
      const had = session.segments.length > 0;
      let added = 0;
      for (const c of assetsToClips(res.assets)) {
        if (c._needsProbe) { const { duration } = await probeVideo(c.uri, { wantThumb: false }); if (duration > 0) c.out = duration; }
        delete c._needsProbe;
        try { await session.addSegment(c); added += 1; } catch {}
      }
      setBusy(null);
      if (!added) { setErr(t('videoStudio.cam.importFailed')); return; }
      if (!had) { const r = await session.finish(); if (r.id) onNext?.(r.id, r.edl); }
    } catch { setBusy(null); setErr(t('videoStudio.cam.importFailed')); }
  }, [recording, busy, session, onNext, t]);

  const next = useCallback(async () => {
    if (recording || !segments.length) return;
    setBusy('next');
    try { const r = await session.finish(); if (r.id) onNext?.(r.id, r.edl); } finally { setBusy(null); }
  }, [recording, segments.length, session, onNext]);

  const close = useCallback(async () => {
    if (recording) { stop(); return; }
    stopStream();
    if (!segments.length) { await session.discard(); onClose?.(); return; }
    // Web: confirm() nativo do navegador (Alert do RN-web não tem 3 botões).
    let keep = false;
    try { keep = window.confirm(t('videoStudio.cam.webKeepDraft')); } catch {}
    if (keep) await session.keepDraft(); else await session.discard();
    onClose?.();
  }, [recording, stop, stopStream, segments.length, session, onClose, t]);

  const css = getStudioFilter(filter?.id).css;
  const timeline = totalS + (recording ? elapsed / 1000 / speed : 0);

  return (
    <View style={styles.root}>
      <View style={styles.stage}>
        {React.createElement('video', {
          ref: videoRef, autoPlay: true, muted: true, playsInline: true,
          style: { width: '100%', height: '100%', objectFit: 'cover', transform: facing === 'user' ? 'scaleX(-1)' : 'none', filter: css || 'none', background: '#000' },
        })}
        {status !== 'ready' && (
          <View style={styles.center}>
            {status === 'init' ? <ActivityIndicator color="#fff" /> : (
              <>
                <Text style={styles.msg}>{status === 'denied' ? t('videoStudio.cam.permBody') : t('videoStudio.cam.webUnsupported')}</Text>
                <Pressable style={styles.primary} onPress={importFile}><Text style={styles.primaryTxt}>{t('videoStudio.cam.importFile')}</Text></Pressable>
              </>
            )}
          </View>
        )}
        <View style={styles.top}>
          <View style={styles.bar}>
            {segments.map((c, i) => (<View key={i} style={[styles.seg, { flexGrow: 0, width: `${(((c.out - c.in) / (c.speed || 1)) / limitS) * 100}%` }]} />))}
            {recording && <View style={[styles.seg, { width: `${((elapsed / 1000 / speed) / limitS) * 100}%`, opacity: 0.85 }]} />}
          </View>
          <View style={styles.topRow}>
            <Pressable onPress={close} style={styles.icon} accessibilityRole="button" accessibilityLabel={t('videoStudio.cam.close')}><IconX size={24} color="#fff" /></Pressable>
            {music ? (
              <Pressable style={styles.music} onPress={() => !recording && setMusic(null)} accessibilityLabel={t('videoStudio.cam.removeSound')}>
                <IconMusic size={14} color="#fff" /><Text style={styles.musicTxt} numberOfLines={1}>{music.title || t('videoStudio.cam.sound')}</Text>
              </Pressable>
            ) : <View style={{ flex: 1 }} />}
            <Text style={styles.time}>{segments.length || recording ? `${fmt(timeline)} / ${fmt(limitS)}` : ''}</Text>
          </View>
        </View>
        {!recording && status === 'ready' && (
          <View style={styles.rail}>
            <Pressable style={styles.railBtn} onPress={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}><IconCameraFlip size={24} color="#fff" /><Text style={styles.railLbl}>{t('videoStudio.cam.flip')}</Text></Pressable>
            <Pressable style={styles.railBtn} onPress={() => setPanel(panel === 'speed' ? null : 'speed')}><Text style={styles.railTxt}>{`${speed}x`}</Text><Text style={styles.railLbl}>{t('videoStudio.cam.speed')}</Text></Pressable>
            <Pressable style={styles.railBtn} onPress={() => setPanel(panel === 'filter' ? null : 'filter')}><IconSparkles size={24} color="#fff" /><Text style={styles.railLbl}>{t('videoStudio.cam.filters')}</Text></Pressable>
          </View>
        )}
        {!!err && <View style={styles.err}><Text style={styles.errTxt}>{err}</Text></View>}
        <View style={styles.bottom}>
          {!recording && panel === 'speed' && (
            <View style={styles.pillRow}>
              {SPEEDS.map((v) => (<Pressable key={v} onPress={() => setSpeed(v)} style={[styles.pill, speed === v && styles.pillOn]}><Text style={[styles.pillTxt, speed === v && styles.pillTxtOn]}>{`${v}x`}</Text></Pressable>))}
            </View>
          )}
          {!recording && panel === 'filter' && (
            <ScrollView horizontal contentContainerStyle={{ gap: 8, paddingHorizontal: 16, marginBottom: 14 }}>
              {STUDIO_FILTERS.map((f) => (<Pressable key={f.id} onPress={() => setFilter({ id: f.id, intensity: 1 })} style={[styles.pill, filter?.id === f.id && styles.pillOn]}><Text style={[styles.pillTxt, filter?.id === f.id && styles.pillTxtOn]}>{t(f.labelKey)}</Text></Pressable>))}
            </ScrollView>
          )}
          <View style={styles.controls}>
            <View style={styles.side}>
              {!recording && <Pressable onPress={importFile} style={styles.gallery} accessibilityRole="button" accessibilityLabel={t('videoStudio.cam.importFile')}><IconImage size={22} color="#fff" /></Pressable>}
            </View>
            <Pressable onPress={recording ? stop : start} disabled={status !== 'ready'} style={[styles.rec, status !== 'ready' && { opacity: 0.4 }]} accessibilityRole="button" accessibilityLabel={recording ? t('videoStudio.cam.stop') : t('videoStudio.cam.record')}>
              <View style={[styles.recInner, recording && styles.recInnerOn]} />
            </Pressable>
            <View style={[styles.side, { flexDirection: 'row', gap: 12, justifyContent: 'center' }]}>
              {!recording && segments.length > 0 && (
                <>
                  <Pressable onPress={() => session.removeLast()} style={styles.small} accessibilityLabel={t('videoStudio.cam.deleteLast')}><IconUndo2 size={20} color="#fff" /></Pressable>
                  <Pressable onPress={next} style={[styles.small, styles.nextBtn]} accessibilityLabel={t('videoStudio.cam.next')}>{busy === 'next' ? <ActivityIndicator size="small" color="#000" /> : <IconCheck size={22} color="#000" />}</Pressable>
                </>
              )}
            </View>
          </View>
          {!recording && !segments.length && (
            <View style={styles.limitRow}>
              {LIMITS_S.slice().reverse().map((s) => (<Pressable key={s} onPress={() => setLimitS(s)}><Text style={[styles.limitTxt, limitS === s && { color: '#fff' }]}>{limitLabel(s)}</Text></Pressable>))}
            </View>
          )}
        </View>
        {busy === 'import' && <View style={styles.center}><ActivityIndicator color="#fff" /><Text style={styles.msg}>{t('videoStudio.cam.importing')}</Text></View>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  stage: { width: '100%', maxWidth: 480, height: '100%', maxHeight: 900, aspectRatio: 9 / 16, backgroundColor: '#000', overflow: 'hidden', position: 'relative' },
  center: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14, backgroundColor: 'rgba(0,0,0,0.6)' },
  msg: { color: '#fff', fontSize: 15, textAlign: 'center', lineHeight: 21 },
  primary: { backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 20, height: 46, justifyContent: 'center' },
  primaryTxt: { color: '#000', fontWeight: '700', fontSize: 15 },
  top: { position: 'absolute', top: 10, left: 12, right: 12 },
  bar: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.28)', flexDirection: 'row', overflow: 'hidden' },
  seg: { height: 4, backgroundColor: '#fff', borderRightWidth: 2, borderRightColor: '#000' },
  topRow: { flexDirection: 'row', alignItems: 'center', marginTop: 10, gap: 10 },
  icon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  music: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.42)', borderRadius: 16, height: 30, paddingHorizontal: 12 },
  musicTxt: { color: '#fff', fontSize: 13, fontWeight: '600' },
  time: { color: '#fff', fontSize: 13, fontWeight: '600', minWidth: 84, textAlign: 'right' },
  rail: { position: 'absolute', right: 8, top: 74, gap: 16, alignItems: 'center' },
  railBtn: { alignItems: 'center', width: 58 },
  railTxt: { color: '#fff', fontSize: 15, fontWeight: '800', height: 24 },
  railLbl: { color: '#fff', fontSize: 11, fontWeight: '600', marginTop: 2 },
  err: { position: 'absolute', top: 70, alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14 },
  errTxt: { color: '#fff', fontSize: 13 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 18, alignItems: 'center' },
  pillRow: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 10, padding: 3, marginBottom: 14 },
  pill: { paddingHorizontal: 13, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  pillOn: { backgroundColor: '#fff' },
  pillTxt: { color: '#fff', fontSize: 13, fontWeight: '700' },
  pillTxtOn: { color: '#000' },
  controls: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  side: { width: 100, alignItems: 'center' },
  gallery: { width: 42, height: 42, borderRadius: 10, borderWidth: 2, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  rec: { width: 84, height: 84, borderRadius: 42, borderWidth: 5, borderColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center' },
  recInner: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#fff' },
  recInnerOn: { width: 28, height: 28, borderRadius: 7 },
  small: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  nextBtn: { backgroundColor: '#fff', borderColor: '#fff' },
  limitRow: { flexDirection: 'row', gap: 22, marginTop: 14 },
  limitTxt: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: '700' },
});
