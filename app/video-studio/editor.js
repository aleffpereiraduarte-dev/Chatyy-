// [2026-10-13 video-studio] EDITOR do Video Studio (nível TikTok).
//
// Entrada: /video-studio/editor?draft=<id>  (rascunho do draftStore, criado pela
// câmera) — ou ?edl=<json> (cria rascunho). Tudo que muda vai para a EDL v1 do
// rascunho (salvo em disco com debounce) → "Avançar" abre /video-studio/publish.
//
// Prévia: components/videoStudio/EdlPreview (2 players expo-video + música/voz
// expo-audio + filtro aproximado + textos/figurinhas/legendas por tempo).
// Linha do tempo: miniaturas, aparar, reordenar, dividir, apagar, velocidade.
// O resultado FIEL vem do render do servidor (ffmpeg) a partir da mesma EDL.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable, Modal, Platform, Alert, ActivityIndicator, BackHandler, useWindowDimensions } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Svg, { Path } from 'react-native-svg';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
import { haptic, DarkColors } from '../../constants/theme';
import { IconType, IconSmile, IconMusic, IconSparkles, IconMic, IconMessageSquare, IconImage, IconDraft, IconTrash, IconCopy, IconFlipHorizontal, IconPencil, IconZap, IconVolume2, IconPlus, IconArrowLeft } from '../../components/Icons';
import EdlPreview, { createClock, useClockValue } from '../../components/videoStudio/EdlPreview';
import OverlayLayer, { CaptionsLayer } from '../../components/videoStudio/OverlayLayer';
import Timeline from '../../components/videoStudio/Timeline';
import TextEditor from '../../components/videoStudio/TextEditor';
import SoundsSheet from '../../components/videoStudio/SoundsSheet';
import { FiltersSheet, CaptionsSheet, CoverSheet, VoiceSheet } from '../../components/videoStudio/ToolSheets';
import { getSourceInfo } from '../../components/videoStudio/thumbs';
import { C } from '../../components/videoStudio/ui';
import { SPEEDS, makeClip, validate } from '../../services/videoStudio/edl';
import {
  totalDuration, splitAt, removeClip, moveClip, duplicateClip, updateClip, setTrim, appendClips,
  addOverlay, updateOverlay, removeOverlay, setOverlayRange, ensureOverlayIds, clampOverlays, clipStarts, fmtTime,
} from '../../services/videoStudio/edlOps';
import { createDraft, loadDraft, updateDraft, saveDraftNow, adoptFile } from '../../services/videoStudio/draftStore';

const HISTORY_MAX = 40;

function IconPlay({ size = 22, color = '#fff' }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}><Path d="M7 4.5v15l12.5-7.5z" /></Svg>;
}
function IconPause({ size = 22, color = '#fff' }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}><Path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" /></Svg>;
}
function IconRedo({ size = 20, color = '#fff' }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Path d="M15 14l5-5-5-5" /><Path d="M20 9H9.5a5.5 5.5 0 000 11H13" /></Svg>;
}
function IconUndoS({ size = 20, color = '#fff' }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Path d="M9 14L4 9l5-5" /><Path d="M4 9h10.5a5.5 5.5 0 010 11H11" /></Svg>;
}
function IconScissors({ size = 20, color = '#fff' }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><Path d="M6 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12" /></Svg>;
}

function TimeLabel({ clock, total }) {
  const sec = useClockValue(clock, (x) => Math.floor(x), 4);
  return <Text style={styles.time}>{`${fmtTime(sec)} / ${fmtTime(total)}`}</Text>;
}

function Tool({ Icon, label, onPress, on }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.tool} accessibilityRole="button" accessibilityLabel={label}>
      <View style={[styles.toolIcon, on && { backgroundColor: '#fff' }]}>
        <Icon size={20} color={on ? '#000' : '#fff'} />
      </View>
      <Text style={styles.toolTxt} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

function Action({ Icon, label, onPress, disabled }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={[styles.action, disabled && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel={label}>
      <Icon size={20} color="#fff" />
      <Text style={styles.actionTxt} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

export default function VideoStudioEditor() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const { t, language } = useLanguage();
  const { user } = useAuth();
  const email = user?.email || '';

  const [draftId, setDraftId] = useState(null);
  const [edl, setEdl] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const [selection, setSelection] = useState(null); // {type:'clip',index} | {type:'overlay',id}
  const [sheet, setSheet] = useState(null);
  const [textEdit, setTextEdit] = useState(null); // { id|null, initial }
  const [playing, setPlaying] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const [adding, setAdding] = useState(false);

  const clock = useMemo(() => createClock(), []);
  const previewRef = useRef(null);
  const edlRef = useRef(null);
  edlRef.current = edl;
  const past = useRef([]);
  const future = useRef([]);
  const draftRef = useRef(null);
  draftRef.current = draftId;

  // ─── Carregar rascunho ──────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      const id = String(params.draft || params.draftId || '');
      if (id) {
        const d = await loadDraft(id);
        if (!alive) return;
        if (d?.edl) { setDraftId(id); setEdl(clampOverlays(ensureOverlayIds(d.edl))); return; }
      }
      if (params.edl) {
        try {
          const e = JSON.parse(String(params.edl));
          const nid = createDraft(e);
          if (!alive) return;
          setDraftId(nid);
          setEdl(ensureOverlayIds(e));
          return;
        } catch {}
      }
      if (alive) setLoadErr(true);
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Commit (histórico + rascunho) ──────────────────────────────────────
  const commit = useCallback((next, { history = true } = {}) => {
    const prev = edlRef.current;
    if (!next || next === prev) return;
    if (history && prev) {
      past.current.push(prev);
      if (past.current.length > HISTORY_MAX) past.current.shift();
      future.current = [];
      setHist({ undo: past.current.length, redo: 0 });
    }
    edlRef.current = next;
    setEdl(next);
    if (draftRef.current) updateDraft(draftRef.current, next);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(edlRef.current);
    edlRef.current = prev;
    setEdl(prev);
    setHist({ undo: past.current.length, redo: future.current.length });
    if (draftRef.current) updateDraft(draftRef.current, prev);
    try { haptic.light(); } catch {}
  }, []);
  const redo = useCallback(() => {
    const nx = future.current.pop();
    if (!nx) return;
    past.current.push(edlRef.current);
    edlRef.current = nx;
    setEdl(nx);
    setHist({ undo: past.current.length, redo: future.current.length });
    if (draftRef.current) updateDraft(draftRef.current, nx);
    try { haptic.light(); } catch {}
  }, []);

  const total = edl ? totalDuration(edl) : 0;

  // ─── Prévia ─────────────────────────────────────────────────────────────
  const pause = useCallback(() => { try { previewRef.current?.pause(); } catch {} }, []);
  const togglePlay = useCallback(() => {
    if (selection?.type === 'overlay') setSelection(null);
    try { previewRef.current?.toggle(); } catch {}
  }, [selection]);
  const seek = useCallback((tt) => { try { previewRef.current?.seek(tt); } catch {} }, []);

  const openSheet = useCallback((name) => {
    if (name !== 'filters' && name !== 'voice') pause();
    setSpeedOpen(false);
    setSheet(name);
  }, [pause]);

  // Android: voltar fecha folhas primeiro.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (voiceBusy) return true;
      if (sheet || textEdit) { setSheet(null); setTextEdit(null); return true; }
      if (selection) { setSelection(null); return true; }
      return false;
    });
    return () => sub.remove();
  }, [sheet, textEdit, selection, voiceBusy]);

  useEffect(() => () => { if (draftRef.current) saveDraftNow(draftRef.current).catch(() => {}); }, []);

  // ─── Clips ──────────────────────────────────────────────────────────────
  const selClip = selection?.type === 'clip' ? selection.index : -1;
  const clip = edl && selClip >= 0 ? edl.clips[selClip] : null;

  const onSelectClip = useCallback((i) => {
    pause();
    setSpeedOpen(false);
    setSelection((s) => (s?.type === 'clip' && s.index === i ? null : { type: 'clip', index: i }));
    const st = clipStarts(edlRef.current)[i] || 0;
    if (clock.t < st || clock.t >= st + 0.01 + totalDuration({ clips: [edlRef.current.clips[i]] })) seek(st + 0.01);
  }, [pause, seek, clock]);

  const onTrim = useCallback((i, inS, outS, srcDur, side) => {
    const e = edlRef.current;
    const next = setTrim(e, i, inS, outS, srcDur || getSourceInfo(e.clips[i]?.uri)?.duration || 0);
    commit(next);
    const st = clipStarts(next)[i] || 0;
    const c = next.clips[i];
    seek(side === 'in' ? st + 0.01 : st + Math.max(0, (c.out - c.in) / (c.speed || 1) - 0.08));
    try { haptic.select(); } catch {}
  }, [commit, seek]);

  const doSplit = useCallback(() => {
    const e = edlRef.current;
    const next = splitAt(e, clock.t);
    if (next === e) { try { haptic.warning(); } catch {} return; }
    commit(next);
    setSelection(null);
    try { haptic.medium(); } catch {}
  }, [commit, clock]);

  const doDeleteClip = useCallback(() => {
    const e = edlRef.current;
    if (selClip < 0) return;
    if (e.clips.length <= 1) { Alert.alert(t('studio.editor.title'), t('studio.editor.lastClip')); return; }
    commit(removeClip(e, selClip));
    setSelection(null);
    try { haptic.medium(); } catch {}
  }, [commit, selClip, t]);

  const doSpeed = useCallback((sp) => {
    if (selClip < 0) return;
    commit(updateClip(edlRef.current, selClip, { speed: sp }));
    try { haptic.select(); } catch {}
  }, [commit, selClip]);

  const onMoveClip = useCallback((from, to) => {
    commit(moveClip(edlRef.current, from, to));
    setSelection(null);
    try { haptic.select(); } catch {}
  }, [commit]);

  const addClips = useCallback(async () => {
    pause();
    let IP = null;
    try { IP = require('expo-image-picker'); } catch {}
    if (!IP) return;
    try {
      const res = await IP.launchImageLibraryAsync({ mediaTypes: ['videos', 'images'], allowsMultipleSelection: true, selectionLimit: 10, quality: 1 });
      if (!res || res.canceled || !res.assets?.length) return;
      setAdding(true);
      const list = [];
      for (const a of res.assets) {
        const isImg = a.type === 'image';
        let uri = a.uri;
        // eslint-disable-next-line no-await-in-loop
        if (draftRef.current) uri = await adoptFile(draftRef.current, a.uri, {});
        let dur = Number(a.duration) || 0;
        if (Platform.OS !== 'web') dur /= 1000; // nativo = ms; web = s
        list.push(makeClip({ uri, in: 0, out: isImg ? 3 : Math.max(0.5, dur || 3), kind: isImg ? 'image' : 'video', w: a.width || undefined, h: a.height || undefined }));
      }
      commit(appendClips(edlRef.current, list));
    } catch {
      Alert.alert(t('studio.editor.title'), t('studio.editor.addFailed'));
    } finally { setAdding(false); }
  }, [commit, pause, t]);

  // ─── Overlays ───────────────────────────────────────────────────────────
  const selOv = selection?.type === 'overlay' ? (edl?.overlays || []).find((o) => o.id === selection.id) : null;

  const onOverlayCommit = useCallback((id, geo) => commit(updateOverlay(edlRef.current, id, geo)), [commit]);
  const onOverlayDelete = useCallback((id) => { commit(removeOverlay(edlRef.current, id)); setSelection(null); try { haptic.medium(); } catch {} }, [commit]);
  const onOverlaySelect = useCallback((id) => { setSelection(id ? { type: 'overlay', id } : null); }, []);
  const onOverlayEdit = useCallback((id) => {
    const o = (edlRef.current.overlays || []).find((x) => x.id === id);
    if (o?.type === 'text') { pause(); setTextEdit({ id, initial: { text: o.text, style: o.style } }); }
  }, [pause]);
  const onOverlayRange = useCallback((id, s, e) => commit(setOverlayRange(edlRef.current, id, s, e)), [commit]);

  const onTextDone = useCallback(({ text, style }) => {
    const te = textEdit;
    setTextEdit(null);
    if (!text) { if (te?.id) onOverlayDelete(te.id); return; }
    if (te?.id) { commit(updateOverlay(edlRef.current, te.id, { text, style })); return; }
    const next = addOverlay(edlRef.current, { type: 'text', text, style }, clock.t);
    commit(next);
    setSelection({ type: 'overlay', id: next.overlays[next.overlays.length - 1].id });
  }, [textEdit, commit, clock, onOverlayDelete]);

  const onStickerPicked = useCallback((item, isGif) => {
    setSheet(null);
    const url = typeof item === 'string' ? item : (item?.url || item?.media_url || item?.uri || '');
    if (!url) return;
    let next;
    if (/^(https?:|file:|content:|data:)/i.test(url)) {
      next = addOverlay(edlRef.current, { type: 'sticker', sticker_url: url, kind: isGif ? 'gif' : undefined }, clock.t);
    } else {
      // Figurinha "texto" (emoji/atalho do teclado) → texto grande.
      next = addOverlay(edlRef.current, { type: 'text', text: url, style: { font: 'classic', color: '#FFFFFF', bg: 'none', align: 'center' } }, clock.t);
      const last = next.overlays[next.overlays.length - 1];
      next = updateOverlay(next, last.id, { scale: 2.2 });
    }
    commit(next);
    setSelection({ type: 'overlay', id: next.overlays[next.overlays.length - 1].id });
  }, [commit, clock]);

  // ─── Avançar ────────────────────────────────────────────────────────────
  const goNext = useCallback(async () => {
    pause();
    const e = edlRef.current;
    const v = validate({ ...e, overlays: (e.overlays || []).map(({ id, kind, ...o }) => o) });
    if (!v.ok) { Alert.alert(t('studio.editor.title'), t('studio.editor.invalid')); return; }
    if (draftRef.current) await saveDraftNow(draftRef.current);
    router.push({ pathname: '/video-studio/publish', params: { draft: draftRef.current } });
  }, [pause, router, t]);

  const close = useCallback(() => {
    pause();
    if (draftRef.current) saveDraftNow(draftRef.current).catch(() => {});
    if (router.canGoBack()) router.back(); else router.replace('/chat');
  }, [pause, router]);

  // ─── Layout da prévia (9:16 cabendo na área) ────────────────────────────
  const onStageArea = useCallback((ev) => {
    const { width, height } = ev.nativeEvent.layout;
    let h = height;
    let w = (h * 9) / 16;
    if (w > width) { w = width; h = (w * 16) / 9; }
    setStage((s) => (Math.abs(s.w - w) < 1 && Math.abs(s.h - h) < 1 ? s : { w: Math.floor(w), h: Math.floor(h) }));
  }, []);

  if (loadErr) {
    return (
      <View style={[styles.root, styles.center, { paddingTop: insets.top }]}>
        <StatusBar style="light" />
        <Text style={styles.errTxt}>{t('studio.editor.notFound')}</Text>
        <TouchableOpacity onPress={close} style={styles.pill}><Text style={styles.pillTxt}>{t('common.back')}</Text></TouchableOpacity>
      </View>
    );
  }
  if (!edl) {
    return <View style={[styles.root, styles.center]}><StatusBar style="light" /><ActivityIndicator color="#fff" /></View>;
  }

  const editable = !playing && !voiceBusy;
  const capLang = String(language || 'pt').slice(0, 2);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <StatusBar style="light" />
      {/* Topo */}
      <View style={styles.top}>
        <TouchableOpacity onPress={close} hitSlop={10} style={styles.topBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <IconArrowLeft size={22} color="#fff" />
        </TouchableOpacity>
        <View style={styles.topMid}>
          <TouchableOpacity onPress={undo} disabled={!hist.undo} hitSlop={8} style={[styles.histBtn, !hist.undo && { opacity: 0.3 }]} accessibilityRole="button" accessibilityLabel={t('studio.editor.undo')}><IconUndoS /></TouchableOpacity>
          <TouchableOpacity onPress={redo} disabled={!hist.redo} hitSlop={8} style={[styles.histBtn, !hist.redo && { opacity: 0.3 }]} accessibilityRole="button" accessibilityLabel={t('studio.editor.redo')}><IconRedo /></TouchableOpacity>
        </View>
        <TouchableOpacity onPress={goNext} style={styles.nextBtn} accessibilityRole="button">
          <Text style={styles.nextTxt}>{t('studio.editor.next')}</Text>
        </TouchableOpacity>
      </View>

      {/* Prévia */}
      <View style={styles.stageArea} onLayout={onStageArea}>
        {stage.w > 0 && (
          <View style={{ width: stage.w, height: stage.h, borderRadius: 14, overflow: 'hidden' }}>
            <EdlPreview
              ref={previewRef}
              edl={edl}
              clock={clock}
              width={stage.w}
              height={stage.h}
              loop={!voiceBusy}
              muteVoice={voiceBusy}
              onPlayingChange={setPlaying}
            >
              <Pressable style={StyleSheet.absoluteFill} onPress={togglePlay} accessibilityRole="button" accessibilityLabel={playing ? t('studio.editor.pause') : t('studio.editor.play')} />
              <CaptionsLayer edl={edl} clock={clock} W={stage.w} H={stage.h} />
              <OverlayLayer
                edl={edl}
                clock={clock}
                W={stage.w}
                H={stage.h}
                editable={editable}
                selectedId={selOv?.id || null}
                onSelect={onOverlaySelect}
                onEdit={onOverlayEdit}
                onCommit={onOverlayCommit}
                onDelete={onOverlayDelete}
              />
              {!playing && !selOv && (
                <View pointerEvents="none" style={styles.playHint}><IconPlay size={30} /></View>
              )}
            </EdlPreview>
          </View>
        )}
        {/* Ferramentas (trilho à direita) */}
        <View style={[styles.rail, { right: 8 }]} pointerEvents={voiceBusy ? 'none' : 'auto'}>
          <Tool Icon={IconType} label={t('studio.tool.text')} onPress={() => { pause(); setTextEdit({ id: null, initial: null }); }} />
          <Tool Icon={IconSmile} label={t('studio.tool.stickers')} onPress={() => openSheet('sticker')} />
          <Tool Icon={IconMusic} label={t('studio.tool.sounds')} onPress={() => openSheet('sounds')} on={!!edl.audio?.music} />
          <Tool Icon={IconSparkles} label={t('studio.tool.filters')} onPress={() => openSheet('filters')} on={edl.filter?.id && edl.filter.id !== 'none'} />
          <Tool Icon={IconMic} label={t('studio.tool.voice')} onPress={() => openSheet('voice')} on={!!edl.audio?.voiceover} />
          <Tool Icon={IconMessageSquare} label={t('studio.tool.captions')} onPress={() => openSheet('captions')} on={!!edl.captions?.enabled} />
          <Tool Icon={IconImage} label={t('studio.tool.cover')} onPress={() => openSheet('cover')} />
        </View>
      </View>

      {/* Controles */}
      <View style={styles.controls}>
        <TimeLabel clock={clock} total={total} />
        <TouchableOpacity onPress={togglePlay} style={styles.playBtn} accessibilityRole="button" accessibilityLabel={playing ? t('studio.editor.pause') : t('studio.editor.play')}>
          {playing ? <IconPause /> : <IconPlay />}
        </TouchableOpacity>
        <View style={{ width: 92, alignItems: 'flex-end' }}>
          {adding ? <ActivityIndicator color="#fff" size="small" /> : null}
        </View>
      </View>

      {/* Linha do tempo */}
      <Timeline
        edl={edl}
        clock={clock}
        width={winW}
        t={t}
        selection={selection}
        onSelectClip={onSelectClip}
        onSelectOverlay={(id) => { pause(); setSelection({ type: 'overlay', id }); }}
        onClearSelection={() => { setSelection(null); setSpeedOpen(false); }}
        onScrubStart={pause}
        onScrub={seek}
        onTrim={onTrim}
        onMoveClip={onMoveClip}
        onOverlayRange={onOverlayRange}
        onAddClip={addClips}
        onOpenSounds={() => openSheet('sounds')}
        onOpenVoice={() => openSheet('voice')}
      />

      {/* Velocidade */}
      {speedOpen && clip && (
        <View style={styles.speedRow}>
          {SPEEDS.map((sp) => {
            const on = (clip.speed || 1) === sp;
            return (
              <TouchableOpacity key={sp} onPress={() => doSpeed(sp)} style={[styles.speedChip, on && styles.speedChipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
                <Text style={[styles.speedTxt, on && { color: '#000' }]}>{`${sp}x`}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* Ações contextuais */}
      <View style={[styles.actions, { paddingBottom: Math.max(10, insets.bottom) }]}>
        {clip ? (
          <>
            <Action Icon={IconZap} label={t('studio.editor.speed')} onPress={() => setSpeedOpen((v) => !v)} />
            <Action Icon={IconScissors} label={t('studio.editor.split')} onPress={doSplit} />
            <Action Icon={IconFlipHorizontal} label={t('studio.editor.mirror')} onPress={() => commit(updateClip(edl, selClip, { mirror: !clip.mirror }))} />
            <Action Icon={IconCopy} label={t('studio.editor.duplicate')} onPress={() => commit(duplicateClip(edl, selClip))} />
            <Action Icon={IconTrash} label={t('studio.delete')} onPress={doDeleteClip} disabled={edl.clips.length <= 1} />
          </>
        ) : selOv ? (
          <>
            {selOv.type === 'text' && <Action Icon={IconPencil} label={t('studio.editor.edit')} onPress={() => onOverlayEdit(selOv.id)} />}
            <Action Icon={IconCopy} label={t('studio.editor.duplicate')} onPress={() => {
              const next = addOverlay(edl, { ...selOv }, selOv.start);
              const last = next.overlays[next.overlays.length - 1];
              commit(updateOverlay(next, last.id, { x: Math.min(0.9, selOv.x + 0.05), y: Math.min(0.9, selOv.y + 0.05), scale: selOv.scale, rotation: selOv.rotation, end: selOv.end }));
            }} />
            <Action Icon={IconTrash} label={t('studio.delete')} onPress={() => onOverlayDelete(selOv.id)} />
          </>
        ) : (
          <>
            <Action Icon={IconScissors} label={t('studio.editor.split')} onPress={doSplit} />
            <Action Icon={IconVolume2} label={t('studio.editor.volume')} onPress={() => openSheet('sounds')} />
            <Action Icon={IconPlus} label={t('studio.tl.addClip')} onPress={addClips} />
            <Action Icon={IconDraft} label={t('studio.editor.drafts')} onPress={() => { pause(); router.push('/video-studio/drafts'); }} />
          </>
        )}
      </View>

      {/* Folhas */}
      <TextEditor visible={!!textEdit} initial={textEdit?.initial} onCancel={() => setTextEdit(null)} onDone={onTextDone} t={t} />
      <StickerSheet visible={sheet === 'sticker'} onClose={() => setSheet(null)} onPick={onStickerPicked} t={t} email={email} bottomInset={insets.bottom} />
      <SoundsSheet
        visible={sheet === 'sounds'}
        onClose={() => setSheet(null)}
        t={t}
        edl={edl}
        videoDur={total}
        onApply={({ music, original_volume }) => {
          setSheet(null);
          commit({ ...edlRef.current, audio: { ...edlRef.current.audio, music, original_volume } });
        }}
      />
      <FiltersSheet visible={sheet === 'filters'} onClose={() => setSheet(null)} t={t} edl={edl}
        onChange={(f) => commit({ ...edlRef.current, filter: f }, { history: edlRef.current.filter?.id !== f.id })} />
      <CaptionsSheet visible={sheet === 'captions'} onClose={() => setSheet(null)} t={t} edl={edl} email={email} lang={capLang} onSeek={seek}
        onApply={(captions) => { setSheet(null); commit({ ...edlRef.current, captions }); }} />
      <CoverSheet visible={sheet === 'cover'} onClose={() => setSheet(null)} t={t} edl={edl} onSeek={seek}
        onApply={(cover) => { setSheet(null); commit({ ...edlRef.current, cover }); }} />
      <VoiceSheet
        visible={sheet === 'voice'}
        onClose={() => setSheet(null)}
        t={t}
        edl={edl}
        clock={clock}
        preview={previewRef}
        onBusy={setVoiceBusy}
        onRecorded={async (uri) => {
          let u = uri;
          if (draftRef.current) u = await adoptFile(draftRef.current, uri, { move: true, ext: 'm4a' });
          commit({ ...edlRef.current, audio: { ...edlRef.current.audio, voiceover: { uri: u, volume: edlRef.current.audio?.voiceover?.volume ?? 1 } } });
        }}
        onRemove={() => commit({ ...edlRef.current, audio: { ...edlRef.current.audio, voiceover: null } })}
        onVolume={(v) => commit({ ...edlRef.current, audio: { ...edlRef.current.audio, voiceover: { ...edlRef.current.audio.voiceover, volume: v } } }, { history: false })}
      />
    </View>
  );
}

// ─── Figurinhas + GIFs ──────────────────────────────────────────────────────
function StickerSheet({ visible, onClose, onPick, t, email, bottomInset }) {
  const [tab, setTab] = useState('stickers');
  const insets = useSafeAreaInsets();
  if (!visible) return null;
  let StickerPicker = null;
  let GifPicker = null;
  try { StickerPicker = require('../../components/StickerPicker').default; } catch {}
  try { GifPicker = require('../../components/GifPicker').default; } catch {}
  // Paleta escura real do app (o seletor usa primary/text/border/textTertiary…).
  const colors = { ...DarkColors, background: '#111111' };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.stkBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.stkPanel, { paddingTop: 8 }]}>
          <View style={styles.stkTabs}>
            {['stickers', 'gifs'].map((k) => (
              <TouchableOpacity key={k} onPress={() => setTab(k)} style={[styles.stkTab, tab === k && styles.stkTabOn]} accessibilityRole="tab" accessibilityState={{ selected: tab === k }}>
                <Text style={[styles.stkTabTxt, tab === k && { color: '#000' }]}>{k === 'stickers' ? t('studio.tool.stickers') : t('studio.stickers.gifs')}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={{ flex: 1 }}>
            {tab === 'stickers' && StickerPicker ? (
              <StickerPicker onSelect={(it) => onPick(it, false)} onClose={onClose} colors={colors} t={t} userEmail={email} bottomInset={bottomInset || insets.bottom} />
            ) : null}
            {tab === 'gifs' && GifPicker ? (
              <GifPicker onSelect={(it) => onPick(it, true)} onClose={onClose} colors={colors} t={t} bottomInset={bottomInset || insets.bottom} />
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16 },
  errTxt: { color: C.fg2, fontSize: 15, textAlign: 'center', paddingHorizontal: 30 },
  pill: { paddingHorizontal: 20, height: 40, borderRadius: 20, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  pillTxt: { color: '#000', fontWeight: '800' },
  top: { height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  topBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  topMid: { flex: 1, flexDirection: 'row', justifyContent: 'center', gap: 18 },
  histBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  nextBtn: { height: 36, paddingHorizontal: 18, borderRadius: 18, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  nextTxt: { color: '#000', fontSize: 14, fontWeight: '800' },
  stageArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  playHint: { position: 'absolute', alignSelf: 'center', top: '45%', width: 58, height: 58, borderRadius: 29, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' },
  rail: { position: 'absolute', top: 8, gap: 10, alignItems: 'center' },
  tool: { alignItems: 'center', width: 58 },
  toolIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.3)' },
  toolTxt: { color: '#fff', fontSize: 10, fontWeight: '700', marginTop: 3, textShadowColor: 'rgba(0,0,0,0.8)', textShadowRadius: 3 },
  controls: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  time: { color: C.fg2, fontSize: 12, width: 92, fontVariant: ['tabular-nums'] },
  playBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  speedRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 6 },
  speedChip: { height: 30, minWidth: 52, paddingHorizontal: 10, borderRadius: 15, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' },
  speedChipOn: { backgroundColor: '#fff', borderColor: '#fff' },
  speedTxt: { color: '#fff', fontSize: 13, fontWeight: '800' },
  actions: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.line },
  action: { alignItems: 'center', minWidth: 60, gap: 4, paddingVertical: 2 },
  actionTxt: { color: '#fff', fontSize: 11, fontWeight: '600' },
  stkBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  stkPanel: { height: '72%', backgroundColor: '#111', borderTopLeftRadius: 18, borderTopRightRadius: 18, overflow: 'hidden' },
  stkTabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingBottom: 8 },
  stkTab: { height: 32, paddingHorizontal: 14, borderRadius: 16, backgroundColor: '#1f1f1f', justifyContent: 'center' },
  stkTabOn: { backgroundColor: '#fff' },
  stkTabTxt: { color: '#fff', fontWeight: '700', fontSize: 13 },
});
