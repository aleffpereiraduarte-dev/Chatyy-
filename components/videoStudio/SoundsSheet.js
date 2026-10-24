// [2026-10-13 video-studio] Folha "Sons": busca + categorias (reels_music_list),
// prévia, escolha do trecho (barra de forma de onda simulada com janela do
// tamanho do vídeo) e volumes (original × música).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator, PanResponder } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Path } from 'react-native-svg';
import { StudioSheet, Slider, Chip, C, PrimaryButton } from './ui';
import { musicList } from '../../services/videoStudio/studioApi';
import { fmtTime } from '../../services/videoStudio/edlOps';

export const MUSIC_CATEGORIES = [
  { id: '', labelKey: 'studio.sounds.catForYou' },
  { id: 'trending', labelKey: 'studio.sounds.catTrending' },
  { id: 'pop', labelKey: 'studio.sounds.catPop' },
  { id: 'hiphop', labelKey: 'studio.sounds.catHiphop' },
  { id: 'electronic', labelKey: 'studio.sounds.catElectronic' },
  { id: 'acoustic', labelKey: 'studio.sounds.catAcoustic' },
  { id: 'chill', labelKey: 'studio.sounds.catChill' },
  { id: 'cinematic', labelKey: 'studio.sounds.catCinematic' },
];

function PlayIcon({ playing }) {
  return playing
    ? <Svg width={16} height={16} viewBox="0 0 24 24" fill="#000"><Path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></Svg>
    : <Svg width={16} height={16} viewBox="0 0 24 24" fill="#000"><Path d="M8 5v14l11-7z" /></Svg>;
}

// Barras "de onda" determinísticas a partir do id (sem decodificar áudio).
function bars(id, n) {
  let h = 2166136261;
  const s = String(id || 'x');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  const out = [];
  for (let i = 0; i < n; i++) { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; out.push(0.25 + (((h >>> 0) % 1000) / 1000) * 0.75); }
  return out;
}

/** Barra para escolher o início do trecho: janela = duração do vídeo. */
function SegmentPicker({ track, videoDur, start, onChange, onCommit }) {
  const total = Math.max(videoDur + 0.1, track.duration || 60);
  const wRef = useRef(1);
  const [w, setW] = useState(1);
  const startRef = useRef(start);
  const base = useRef(0);
  startRef.current = start;
  const winW = Math.max(16, (Math.min(videoDur, total) / total) * w);
  const maxStart = Math.max(0, total - videoDur);
  const pr = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { base.current = startRef.current; },
    onPanResponderMove: (_e, g) => { const v = Math.max(0, Math.min(maxStart, base.current + (g.dx / wRef.current) * total)); onChange(v); },
    onPanResponderRelease: (_e, g) => { const v = Math.max(0, Math.min(maxStart, base.current + (g.dx / wRef.current) * total)); onCommit(v); },
  }), [maxStart, total, onChange, onCommit]);
  const b = useMemo(() => bars(track.id, 64), [track.id]);
  return (
    <View>
      <View style={styles.wave} onLayout={(e) => { wRef.current = Math.max(1, e.nativeEvent.layout.width); setW(wRef.current); }} {...pr.panHandlers}>
        {b.map((v, i) => <View key={i} style={[styles.waveBar, { height: `${Math.round(v * 100)}%` }]} />)}
        <View pointerEvents="none" style={[styles.window, { left: (start / total) * w, width: winW }]} />
      </View>
      <View style={styles.segRow}>
        <Text style={styles.segTxt}>{fmtTime(start)}</Text>
        <Text style={styles.segTxt}>{fmtTime(total)}</Text>
      </View>
    </View>
  );
}

/**
 * props: visible, onClose, t, edl, videoDur, onApply({music|null, original_volume}), onPreviewChange(bool)
 */
export default function SoundsSheet({ visible, onClose, t, edl, videoDur, onApply }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [tracks, setTracks] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [playingId, setPlayingId] = useState(null);
  const [picked, setPicked] = useState(null); // { track, start, volume }
  const [origVol, setOrigVol] = useState(edl?.audio?.original_volume ?? 1);
  const playerRef = useRef(null);
  const reqRef = useRef(0);
  const debRef = useRef(null);

  useEffect(() => {
    if (!visible) return;
    setOrigVol(edl?.audio?.original_volume ?? 1);
    const m = edl?.audio?.music;
    setPicked(m ? { track: { id: m.id, title: m.title || '', artist: m.artist || '', duration: m.duration || 0, url: m.url, url_preview: m.url, cover: m.cover || '' }, start: m.start || 0, volume: m.volume ?? 0.6 } : null);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopPreview = useCallback(() => {
    try { playerRef.current?.pause(); playerRef.current?.remove?.(); } catch {}
    playerRef.current = null;
    setPlayingId(null);
  }, []);
  useEffect(() => { if (!visible) stopPreview(); }, [visible, stopPreview]);
  useEffect(() => () => stopPreview(), [stopPreview]);

  const load = useCallback(async (reset) => {
    const id = ++reqRef.current;
    setLoading(true);
    setErr(null);
    const r = await musicList({ q: q.trim(), category: cat, cursor: reset ? null : cursor });
    if (id !== reqRef.current) return;
    setLoading(false);
    // [2026-10-23 reels-sumiu] mede a biblioteca vazia (era 0 faixas em prod → "não dá p/ pôr música").
    if (reset) { try { require('../../services/videoStudio/diag').vsDiag('ed_music', { ok: r.ok ? 1 : 0, n: (r.tracks || []).length, q: q.trim() ? 1 : 0, leg: r.legacy ? 1 : 0 }); } catch {} }
    if (!r.ok) { setErr(r.missing ? 'missing' : 'error'); if (reset) setTracks([]); return; }
    setTracks((prev) => (reset ? r.tracks : [...prev, ...r.tracks.filter((x) => !prev.some((p) => p.id === x.id))]));
    setCursor(r.cursor || null);
  }, [q, cat, cursor]);

  useEffect(() => {
    if (!visible) return undefined;
    clearTimeout(debRef.current);
    debRef.current = setTimeout(() => load(true), q ? 350 : 0);
    return () => clearTimeout(debRef.current);
  }, [visible, q, cat]); // eslint-disable-line react-hooks/exhaustive-deps

  const playFrom = useCallback((track, from = 0) => {
    stopPreview();
    // [2026-10-20 call-audio-guard] prévia de música = som de UI: muda durante ligação
    try { if (require('../../services/callAudioGuard').blockIfCall('play')) { setPlayingId(null); return; } } catch {}
    try {
      const A = require('expo-audio');
      const pl = A.createAudioPlayer({ uri: track.url_preview || track.url }, { updateInterval: 500 });
      playerRef.current = pl;
      try { pl.volume = 1; } catch {}
      // [2026-10-21 media-audit] fim da prévia → ícone volta a "tocar" (antes ficava preso em pausa).
      try {
        pl.addListener?.('playbackStatusUpdate', (st) => {
          if (st?.didJustFinish && playerRef.current === pl) setPlayingId((cur) => (cur === track.id ? null : cur));
        });
      } catch {}
      if (from > 0) pl.seekTo(from).catch?.(() => {});
      pl.play();
      setPlayingId(track.id);
    } catch { setPlayingId(null); }
  }, [stopPreview]);

  const togglePreview = useCallback((track) => {
    if (playingId === track.id) { stopPreview(); return; }
    playFrom(track, 0);
  }, [playingId, playFrom, stopPreview]);

  const choose = useCallback((track) => {
    setPicked({ track, start: 0, volume: picked?.volume ?? 0.6 });
    playFrom(track, 0);
  }, [picked, playFrom]);

  const apply = () => {
    stopPreview();
    const music = picked ? {
      id: picked.track.id,
      url: picked.track.url,
      start: Math.round(picked.start * 1000) / 1000,
      volume: Math.round(picked.volume * 100) / 100,
      title: picked.track.title || undefined,
      artist: picked.track.artist || undefined,
      cover: picked.track.cover || undefined,
      duration: picked.track.duration || undefined,
    } : null;
    onApply({ music, original_volume: Math.round(origVol * 100) / 100 });
  };

  const renderItem = ({ item }) => {
    const on = picked?.track?.id === item.id;
    return (
      <TouchableOpacity onPress={() => choose(item)} style={[styles.row, on && styles.rowOn]} accessibilityRole="button">
        <View style={styles.cover}>
          {item.cover ? <Image source={{ uri: item.cover }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
          <TouchableOpacity onPress={() => togglePreview(item)} style={styles.playBtn} hitSlop={6} accessibilityRole="button" accessibilityLabel={t('studio.sounds.preview')}>
            <PlayIcon playing={playingId === item.id} />
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.trTitle} numberOfLines={1}>{item.title || t('studio.sounds.untitled')}</Text>
          <Text style={styles.trSub} numberOfLines={1}>{[item.artist, item.duration ? fmtTime(item.duration) : null].filter(Boolean).join(' · ')}</Text>
        </View>
        {on ? <View style={styles.usePill}><Text style={styles.useTxt}>{t('studio.sounds.selected')}</Text></View> : <Text style={styles.useLink}>{t('studio.sounds.use')}</Text>}
      </TouchableOpacity>
    );
  };

  return (
    <StudioSheet visible={visible} onClose={() => { stopPreview(); onClose(); }} title={t('studio.sounds.title')} full
      right={<TouchableOpacity onPress={apply} hitSlop={10} accessibilityRole="button"><Text style={styles.done}>{t('studio.done')}</Text></TouchableOpacity>}>
      <View style={styles.searchWrap}>
        <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={C.fg3} strokeWidth={2} strokeLinecap="round"><Path d="M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3" /></Svg>
        <TextInput value={q} onChangeText={setQ} placeholder={t('studio.sounds.search')} placeholderTextColor={C.fg3} style={styles.search} returnKeyType="search" autoCorrect={false} />
      </View>
      <View>
        <FlatList
          horizontal
          data={MUSIC_CATEGORIES}
          keyExtractor={(c) => c.id || 'all'}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 14, gap: 8, paddingVertical: 8 }}
          renderItem={({ item }) => <Chip label={t(item.labelKey)} on={cat === item.id} onPress={() => setCat(item.id)} />}
        />
      </View>
      <FlatList
        style={{ flex: 1 }}
        data={tracks}
        keyExtractor={(x) => x.id}
        renderItem={renderItem}
        onEndReached={() => { if (cursor && !loading) load(false); }}
        onEndReachedThreshold={0.4}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={loading ? null : (
          <Text style={styles.empty}>{err === 'missing' ? t('studio.sounds.unavailable') : err ? t('studio.sounds.error') : t('studio.sounds.empty')}</Text>
        )}
        ListFooterComponent={loading ? <ActivityIndicator color="#fff" style={{ margin: 16 }} /> : null}
      />
      <View style={styles.footer}>
        {picked ? (
          <>
            <View style={styles.pickedHead}>
              <Text style={styles.pickedTitle} numberOfLines={1}>{picked.track.title || t('studio.sounds.untitled')}</Text>
              <TouchableOpacity onPress={() => { stopPreview(); setPicked(null); }} hitSlop={8} accessibilityRole="button"><Text style={styles.remove}>{t('studio.sounds.remove')}</Text></TouchableOpacity>
            </View>
            <Text style={styles.label}>{t('studio.sounds.segment')}</Text>
            <SegmentPicker
              track={picked.track}
              videoDur={videoDur}
              start={picked.start}
              onChange={(v) => setPicked((p) => (p ? { ...p, start: v } : p))}
              onCommit={(v) => { setPicked((p) => (p ? { ...p, start: v } : p)); playFrom(picked.track, v); }}
            />
            <View style={styles.volRow}>
              <Text style={styles.volLabel}>{t('studio.sounds.musicVolume')}</Text>
              <Slider value={picked.volume} onChange={(v) => setPicked((p) => (p ? { ...p, volume: v } : p))} style={{ flex: 1 }} />
              <Text style={styles.volPct}>{Math.round(picked.volume * 100)}</Text>
            </View>
          </>
        ) : null}
        <View style={styles.volRow}>
          <Text style={styles.volLabel}>{t('studio.sounds.originalVolume')}</Text>
          <Slider value={origVol} onChange={setOrigVol} style={{ flex: 1 }} />
          <Text style={styles.volPct}>{Math.round(origVol * 100)}</Text>
        </View>
        <PrimaryButton label={t('studio.sounds.apply')} onPress={apply} style={{ marginTop: 6 }} />
      </View>
    </StudioSheet>
  );
}

const styles = StyleSheet.create({
  done: { color: '#fff', fontWeight: '800', fontSize: 15 },
  searchWrap: { marginHorizontal: 14, height: 40, borderRadius: 12, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
  search: { flex: 1, color: '#fff', fontSize: 15, paddingVertical: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 8 },
  rowOn: { backgroundColor: 'rgba(255,255,255,0.06)' },
  cover: { width: 48, height: 48, borderRadius: 8, backgroundColor: '#222', overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  playBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center' },
  trTitle: { color: '#fff', fontSize: 14, fontWeight: '700' },
  trSub: { color: C.fg2, fontSize: 12, marginTop: 2 },
  useLink: { color: '#fff', fontSize: 13, fontWeight: '700' },
  usePill: { backgroundColor: '#fff', borderRadius: 12, paddingHorizontal: 10, height: 24, justifyContent: 'center' },
  useTxt: { color: '#000', fontSize: 12, fontWeight: '800' },
  empty: { color: C.fg2, textAlign: 'center', marginTop: 30, paddingHorizontal: 24, lineHeight: 20 },
  footer: { borderTopWidth: 1, borderTopColor: C.line, paddingHorizontal: 14, paddingTop: 10, gap: 4 },
  pickedHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pickedTitle: { color: '#fff', fontSize: 14, fontWeight: '800', flex: 1, marginRight: 10 },
  remove: { color: C.fg2, fontSize: 13, fontWeight: '700' },
  label: { color: C.fg2, fontSize: 12, marginTop: 6 },
  wave: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 6 },
  waveBar: { flex: 1, backgroundColor: 'rgba(255,255,255,0.35)', borderRadius: 1 },
  window: { position: 'absolute', top: 0, bottom: 0, borderWidth: 2, borderColor: '#fff', borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.12)' },
  segRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  segTxt: { color: C.fg3, fontSize: 11 },
  volRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  volLabel: { color: C.fg2, fontSize: 12, width: 92 },
  volPct: { color: C.fg2, fontSize: 12, width: 28, textAlign: 'right' },
});
