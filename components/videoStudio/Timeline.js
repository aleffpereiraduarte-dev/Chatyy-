// [2026-10-13 video-studio] Linha do tempo do editor.
//
// Cursor fixo no centro; a fita rola por baixo (rolar = navegar, prévia pausa e
// acompanha). Durante a reprodução a fita segue o relógio via scrollTo (sem
// re-render). Linhas: régua · clips (miniaturas, corte por handles, toque
// seleciona, toque-longo entra em "reordenar") · textos/figurinhas (barras com
// início/fim ajustáveis) · áudio (som e voz).
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Pressable, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Path } from 'react-native-svg';
import DragHandle from './DragHandle';
import { useSourceInfo, thumbAt, getSourceInfo } from './thumbs';
import { clipDuration } from '../../services/videoStudio/edl';
import { totalDuration, MIN_CLIP_S, MIN_OVERLAY_S } from '../../services/videoStudio/edlOps';

const CLIP_H = 54;
const TILE_W = 32;
const HANDLE_W = 14;
const LANE_H = 24;
const AUDIO_H = 24;

const r3 = (n) => Math.round(n * 1000) / 1000;

function IconPlus({ size = 18, color = '#fff' }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round"><Path d="M12 5v14M5 12h14" /></Svg>;
}
function IconGrip({ color = '#000' }) {
  return <Svg width={6} height={16} viewBox="0 0 6 16" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round"><Path d="M2 3v10M4.5 3v10" /></Svg>;
}

// ─── Clip ───────────────────────────────────────────────────────────────────
const ClipBlock = memo(function ClipBlock({ clip, index, pps, selected, onSelect, onLongPress, onTrim, onTouch, speedLabel }) {
  const info = useSourceInfo(clip);
  const dur = clipDuration(clip);
  const width = Math.max(8, dur * pps);
  const sp = clip.speed || 1;
  const n = Math.min(60, Math.max(1, Math.ceil(width / TILE_W)));
  const tiles = [];
  for (let k = 0; k < n; k++) {
    const off = ((k + 0.5) * TILE_W) / pps;
    const src = clip.kind === 'image' ? { uri: clip.uri } : (thumbAt(info, clip.in + off * sp) || (clip.thumb ? { uri: clip.thumb } : null));
    tiles.push(
      <View key={k} style={styles.tile}>
        {src ? <Image source={src} style={[styles.tileImg, clip.mirror ? { transform: [{ scaleX: -1 }] } : null]} contentFit="cover" recyclingKey={`${clip.uri}_${k}`} /> : null}
      </View>,
    );
  }
  const srcDur = clip.kind === 'image' ? 60 : (info?.duration || getSourceInfo(clip.uri)?.duration || 0);
  // Limites dos handles (px na timeline).
  const leftMin = (-clip.in / sp) * pps;
  const leftMax = ((clip.out - MIN_CLIP_S * sp - clip.in) / sp) * pps;
  const rightMin = ((clip.in + MIN_CLIP_S * sp - clip.out) / sp) * pps;
  const rightMax = srcDur > clip.out ? ((srcDur - clip.out) / sp) * pps : 0;

  return (
    <View style={{ width, height: CLIP_H }}>
      <Pressable
        onPress={() => onSelect(index)}
        onLongPress={() => onLongPress(index)}
        delayLongPress={320}
        style={[styles.clip, { width }, selected && styles.clipSel]}
        accessibilityRole="button"
      >
        <View style={styles.tiles}>{tiles}</View>
        {sp !== 1 && <View style={styles.speedBadge}><Text style={styles.speedTxt}>{speedLabel(sp)}</Text></View>}
      </Pressable>
      {selected && (
        <>
          <DragHandle
            style={[styles.handle, styles.handleL]}
            minDx={leftMin}
            maxDx={leftMax}
            hitSlop={{ left: 14, right: 8, top: 8, bottom: 8 }}
            onTouch={onTouch}
            onEnd={(dx) => onTrim(index, r3(clip.in + (dx / pps) * sp), clip.out, srcDur, 'in')}
          >
            <IconGrip />
          </DragHandle>
          <DragHandle
            style={[styles.handle, styles.handleR]}
            minDx={rightMin}
            maxDx={rightMax}
            hitSlop={{ left: 8, right: 14, top: 8, bottom: 8 }}
            onTouch={onTouch}
            onEnd={(dx) => onTrim(index, clip.in, r3(clip.out + (dx / pps) * sp), srcDur, 'out')}
          >
            <IconGrip />
          </DragHandle>
        </>
      )}
    </View>
  );
});

// ─── Reordenar ──────────────────────────────────────────────────────────────
const REORDER_TILE = 58;
function ReorderStrip({ edl, onMove, onDone, t }) {
  const step = REORDER_TILE + 8;
  const n = edl.clips.length;
  return (
    <View style={styles.reorderWrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, alignItems: 'center' }} scrollEnabled={false}>
        {edl.clips.map((c, i) => (
          <DragHandle
            key={`${c.uri}_${i}_${c.in}`}
            style={styles.reorderTile}
            minDx={-i * step}
            maxDx={(n - 1 - i) * step}
            onEnd={(dx) => { const to = Math.max(0, Math.min(n - 1, i + Math.round(dx / step))); if (to !== i) onMove(i, to); }}
          >
            <ReorderThumb clip={c} />
            <Text style={styles.reorderIdx}>{i + 1}</Text>
          </DragHandle>
        ))}
      </ScrollView>
      <TouchableOpacity onPress={onDone} style={styles.reorderDone} accessibilityRole="button">
        <Text style={styles.reorderDoneTxt}>{t('studio.done')}</Text>
      </TouchableOpacity>
    </View>
  );
}
function ReorderThumb({ clip }) {
  const info = useSourceInfo(clip);
  const src = clip.kind === 'image' ? { uri: clip.uri } : (thumbAt(info, clip.in + 0.2) || (clip.thumb ? { uri: clip.thumb } : null));
  return src ? <Image source={src} style={StyleSheet.absoluteFill} contentFit="cover" /> : null;
}

// ─── Overlays ───────────────────────────────────────────────────────────────
function lanesFor(overlays) {
  const lanes = [];
  const out = {};
  [...overlays].sort((a, b) => a.start - b.start).forEach((o) => {
    let li = lanes.findIndex((end) => end <= o.start + 0.001);
    if (li < 0) { if (lanes.length < 3) { lanes.push(0); li = lanes.length - 1; } else li = lanes.length - 1; }
    lanes[li] = o.end;
    out[o.id] = li;
  });
  return { map: out, count: Math.max(1, lanes.length) };
}

function OverlayBar({ o, lane, pps, total, selected, onSelect, onRange, onTouch, label }) {
  const left = o.start * pps;
  const width = Math.max(10, (o.end - o.start) * pps);
  const top = lane * LANE_H;
  const body = (
    <View style={[styles.ovBar, selected && styles.ovBarSel]}>
      <Text numberOfLines={1} style={[styles.ovTxt, selected && { color: '#000' }]}>{label}</Text>
    </View>
  );
  if (!selected) {
    return (
      <Pressable onPress={() => onSelect(o.id)} style={[styles.ovWrap, { left, width, top }]}>{body}</Pressable>
    );
  }
  return (
    <View style={[styles.ovWrap, { left, width, top }]}>
      <DragHandle
        style={StyleSheet.absoluteFill}
        minDx={-o.start * pps}
        maxDx={(total - o.end) * pps}
        onTouch={onTouch}
        onEnd={(dx) => { const d = dx / pps; onRange(o.id, o.start + d, o.end + d); }}
      >
        {body}
      </DragHandle>
      <DragHandle
        style={[styles.ovHandle, { left: -8 }]}
        minDx={-o.start * pps}
        maxDx={(o.end - o.start - MIN_OVERLAY_S) * pps}
        hitSlop={{ left: 10, right: 6, top: 6, bottom: 6 }}
        onTouch={onTouch}
        onEnd={(dx) => onRange(o.id, o.start + dx / pps, o.end)}
      ><View style={styles.ovHandleBar} /></DragHandle>
      <DragHandle
        style={[styles.ovHandle, { right: -8 }]}
        minDx={(MIN_OVERLAY_S - (o.end - o.start)) * pps}
        maxDx={(total - o.end) * pps}
        hitSlop={{ left: 6, right: 10, top: 6, bottom: 6 }}
        onTouch={onTouch}
        onEnd={(dx) => onRange(o.id, o.start, o.end + dx / pps)}
      ><View style={styles.ovHandleBar} /></DragHandle>
    </View>
  );
}

// ─── Régua ──────────────────────────────────────────────────────────────────
function Ruler({ total, pps }) {
  const step = pps >= 60 ? 1 : pps >= 30 ? 2 : pps >= 12 ? 5 : 10;
  const marks = [];
  for (let s = 0; s <= total + 0.001 && marks.length < 200; s += step) {
    marks.push(
      <View key={s} style={[styles.mark, { left: s * pps }]}>
        <View style={styles.markTick} />
        <Text style={styles.markTxt}>{`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`}</Text>
      </View>,
    );
  }
  return <View style={{ height: 16, width: total * pps }}>{marks}</View>;
}

/**
 * props: edl, clock, width, t (i18n), selection {type,index|id}, onSelectClip, onSelectOverlay, onClearSelection,
 *        onScrubStart, onScrub(t), onTrim(i,in,out,srcDur,side), onMoveClip, onOverlayRange,
 *        onAddClip, onOpenSounds, onOpenVoice
 */
export default function Timeline(props) {
  const {
    edl, clock, width, t, selection, onSelectClip, onSelectOverlay, onClearSelection,
    onScrubStart, onScrub, onTrim, onMoveClip, onOverlayRange, onAddClip, onOpenSounds, onOpenVoice,
  } = props;
  const total = totalDuration(edl);
  const pps = useMemo(() => Math.max(14, Math.min(90, (width * 1.25) / Math.max(1, Math.min(total, 60)))), [width, total]);
  const half = width / 2;
  const scrollRef = useRef(null);
  const userRef = useRef(false);
  const lastScrub = useRef(0);
  const scrubTimer = useRef(null);
  const [reorder, setReorder] = useState(false);
  const [locked, setLocked] = useState(false);

  // Relógio → posição (sem re-render).
  useEffect(() => {
    if (!clock) return undefined;
    let raf = 0;
    const un = clock.subscribe(() => {
      if (userRef.current) {
        if (!clock.playing) return;
        userRef.current = false; // tocando de novo → a fita volta a seguir o relógio
      }
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; try { scrollRef.current?.scrollTo({ x: clock.t * pps, animated: false }); } catch {} });
    });
    try { scrollRef.current?.scrollTo({ x: clock.t * pps, animated: false }); } catch {}
    return () => { un(); if (raf) cancelAnimationFrame(raf); };
  }, [clock, pps]);

  const emitScrub = useCallback((x) => {
    const tt = Math.max(0, Math.min(total, x / pps));
    const now = Date.now();
    clearTimeout(scrubTimer.current);
    if (now - lastScrub.current > 70) { lastScrub.current = now; onScrub(tt); } else scrubTimer.current = setTimeout(() => { lastScrub.current = Date.now(); onScrub(tt); }, 70);
  }, [total, pps, onScrub]);

  const onScroll = useCallback((e) => { if (userRef.current) emitScrub(e.nativeEvent.contentOffset.x); }, [emitScrub]);
  const begin = useCallback(() => { userRef.current = true; onScrubStart?.(); }, [onScrubStart]);
  const endDrag = useCallback((e) => {
    const v = e?.nativeEvent?.velocity?.x || 0;
    if (Math.abs(v) < 0.05) { userRef.current = false; emitScrub(e.nativeEvent.contentOffset.x); }
  }, [emitScrub]);
  const endMomentum = useCallback((e) => { userRef.current = false; emitScrub(e.nativeEvent.contentOffset.x); }, [emitScrub]);

  const overlays = edl.overlays || [];
  const lanes = useMemo(() => lanesFor(overlays), [overlays]);
  const speedLabel = useCallback((sp) => `${sp}x`, []);
  const ovLabel = (o) => (o.type === 'sticker' ? t('studio.tl.sticker') : (o.text || t('studio.tl.text')));

  if (reorder) {
    return <ReorderStrip edl={edl} t={t} onMove={(a, b) => onMoveClip(a, b)} onDone={() => setReorder(false)} />;
  }

  const music = edl.audio?.music;
  const vo = edl.audio?.voiceover;
  const contentW = total * pps;
  return (
    <View style={styles.wrap}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEnabled={!locked}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onScrollBeginDrag={begin}
        onScrollEndDrag={endDrag}
        onMomentumScrollEnd={endMomentum}
        contentContainerStyle={{ paddingLeft: half, paddingRight: half }}
        decelerationRate="fast"
      >
        <Pressable onPress={onClearSelection} style={{ width: contentW + 60 }}>
          <Ruler total={total} pps={pps} />
          <View style={styles.clipRow}>
            {edl.clips.map((c, i) => (
              <ClipBlock
                key={`${i}_${c.uri}_${c.in}`}
                clip={c}
                index={i}
                pps={pps}
                selected={selection?.type === 'clip' && selection.index === i}
                onSelect={onSelectClip}
                onLongPress={() => setReorder(edl.clips.length > 1)}
                onTrim={onTrim}
                onTouch={setLocked}
                speedLabel={speedLabel}
              />
            ))}
            <TouchableOpacity onPress={onAddClip} style={styles.addBtn} accessibilityRole="button" accessibilityLabel={t('studio.tl.addClip')}>
              <IconPlus />
            </TouchableOpacity>
          </View>
          {overlays.length > 0 && (
            <View style={{ height: lanes.count * LANE_H, marginTop: 6, width: contentW }}>
              {overlays.map((o) => (
                <OverlayBar
                  key={o.id}
                  o={o}
                  lane={lanes.map[o.id] || 0}
                  pps={pps}
                  total={total}
                  selected={selection?.type === 'overlay' && selection.id === o.id}
                  onSelect={onSelectOverlay}
                  onRange={onOverlayRange}
                  onTouch={setLocked}
                  label={ovLabel(o)}
                />
              ))}
            </View>
          )}
          <View style={{ marginTop: 6, width: contentW, gap: 4 }}>
{(!!onOpenSounds || !!music) && (
            <Pressable onPress={onOpenSounds} style={[styles.audioBar, { width: contentW }, !music && styles.audioEmpty]}>
              <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round"><Path d="M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z" /></Svg>
              <Text numberOfLines={1} style={styles.audioTxt}>{music ? [music.title, music.artist].filter(Boolean).join(' · ') || t('studio.sounds.title') : t('studio.tl.addSound')}</Text>
            </Pressable>
            )}
            {!!vo && (
              <Pressable onPress={onOpenVoice} style={[styles.audioBar, styles.voiceBar, { width: contentW }]}>
                <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round"><Path d="M12 2a3 3 0 00-3 3v7a3 3 0 006 0V5a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v3" /></Svg>
                <Text numberOfLines={1} style={styles.audioTxt}>{t('studio.voice.track')}</Text>
              </Pressable>
            )}
          </View>
        </Pressable>
      </ScrollView>
      <View pointerEvents="none" style={[styles.playhead, { left: half - 1 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', paddingVertical: 4 },
  clipRow: { flexDirection: 'row', alignItems: 'center', height: CLIP_H + 4 },
  clip: { height: CLIP_H, borderRadius: 6, overflow: 'hidden', backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#000' },
  clipSel: { borderWidth: 2, borderColor: '#fff' },
  tiles: { flexDirection: 'row', height: '100%' },
  tile: { width: TILE_W, height: '100%', backgroundColor: '#222', borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: 'rgba(0,0,0,0.4)' },
  tileImg: { width: '100%', height: '100%' },
  speedBadge: { position: 'absolute', left: 4, bottom: 4, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  speedTxt: { color: '#fff', fontSize: 10, fontWeight: '800' },
  handle: { position: 'absolute', top: 0, width: HANDLE_W, height: CLIP_H, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', zIndex: 5 },
  handleL: { left: 0, borderTopLeftRadius: 6, borderBottomLeftRadius: 6 },
  handleR: { right: 0, borderTopRightRadius: 6, borderBottomRightRadius: 6 },
  addBtn: { width: 44, height: CLIP_H, marginLeft: 10, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)', alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
  ovWrap: { position: 'absolute', height: LANE_H - 4 },
  ovBar: { flex: 1, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.18)', justifyContent: 'center', paddingHorizontal: 6 },
  ovBarSel: { backgroundColor: '#fff' },
  ovTxt: { color: '#fff', fontSize: 11, fontWeight: '700' },
  ovHandle: { position: 'absolute', top: -2, width: 16, height: LANE_H, alignItems: 'center', justifyContent: 'center', zIndex: 5 },
  ovHandleBar: { width: 5, height: LANE_H - 6, borderRadius: 3, backgroundColor: '#fff', borderWidth: 1, borderColor: '#000' },
  audioBar: { height: AUDIO_H, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.12)', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8 },
  audioEmpty: { backgroundColor: 'transparent', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', borderStyle: 'dashed' },
  voiceBar: { backgroundColor: 'rgba(255,255,255,0.22)' },
  audioTxt: { color: '#fff', fontSize: 11, fontWeight: '600', flexShrink: 1 },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: '#fff', borderRadius: 1 },
  mark: { position: 'absolute', top: 0, alignItems: 'flex-start' },
  markTick: { width: 1, height: 4, backgroundColor: 'rgba(255,255,255,0.4)' },
  markTxt: { color: 'rgba(255,255,255,0.45)', fontSize: 9, marginTop: 1 },
  reorderWrap: { paddingVertical: 12, gap: 10, alignItems: 'center' },
  reorderTile: { width: REORDER_TILE, height: REORDER_TILE, borderRadius: 8, overflow: 'hidden', backgroundColor: '#222', marginRight: 8, alignItems: 'flex-end', justifyContent: 'flex-end' },
  reorderIdx: { color: '#fff', fontSize: 11, fontWeight: '800', margin: 4, textShadowColor: '#000', textShadowRadius: 3 },
  reorderDone: { paddingHorizontal: 18, height: 32, borderRadius: 16, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  reorderDoneTxt: { color: '#000', fontWeight: '800', fontSize: 13 },
});
