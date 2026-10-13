// [2026-10-13 video-studio] Sessão de gravação em segmentos (compartilhada por câmera nativa e web).
// Os "segmentos" JÁ são clips da EDL v1 (uri/in/out/speed/mirror + extensões opcionais kind/camera/w/h).
// Cada mudança vai p/ o draftStore (memória + disco): app fechado no meio da gravação = trechos salvos.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { newEdl, makeClip, duration as edlDuration, validate, IMAGE_CLIP_SECONDS } from './edl';
import {
  createDraft, getDraft, loadDraft, updateDraft, saveDraftNow, deleteDraft, adoptFile, removeDraftFile,
} from './draftStore';

export const LIMITS_S = [15, 60, 180];

export function useSegmentSession({ draftId: initialDraftId, initialMusic = null } = {}) {
  const [segments, setSegments] = useState([]);
  const [limitS, setLimitS] = useState(60);
  const [filter, setFilter] = useState({ id: 'none', intensity: 1 });
  const [music, setMusic] = useState(initialMusic || null);
  const [restored, setRestored] = useState(!initialDraftId);
  const draftIdRef = useRef(initialDraftId || null);
  const segRef = useRef([]);
  const stateRef = useRef({ limitS: 60, filter: { id: 'none', intensity: 1 }, music: initialMusic || null });
  stateRef.current = { limitS, filter, music };

  // Retomar rascunho (?draft=id).
  useEffect(() => {
    if (!initialDraftId) return undefined;
    let alive = true;
    loadDraft(initialDraftId).then((d) => {
      if (!alive) return;
      if (d?.edl) {
        const clips = Array.isArray(d.edl.clips) ? d.edl.clips : [];
        segRef.current = clips;
        setSegments(clips);
        if (d.edl.meta?.limit_s) setLimitS(d.edl.meta.limit_s);
        if (d.edl.filter?.id) setFilter(d.edl.filter);
        if (d.edl.audio?.music && !initialMusic) setMusic(d.edl.audio.music);
      } else {
        draftIdRef.current = null;
      }
      setRestored(true);
    }).catch(() => setRestored(true));
    return () => { alive = false; };
  }, [initialDraftId]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildEdl = useCallback((segs) => {
    const { limitS: lim, filter: f, music: m } = stateRef.current;
    const base = (draftIdRef.current && getDraft(draftIdRef.current)?.edl) || null;
    const allGallery = segs.length > 0 && segs.every((c) => c.camera === 'gallery' || !c.camera);
    const edl = base ? { ...base } : newEdl({ source: allGallery ? 'gallery' : 'camera' });
    edl.clips = segs.map((c) => ({ ...c }));
    edl.filter = { ...(edl.filter || {}), ...f };
    edl.audio = { ...(edl.audio || { original_volume: 1, voiceover: null }), music: m ? { id: m.id || null, url: m.url || '', start: Number(m.start) || 0, volume: m.volume != null ? m.volume : 0.6, ...(m.title ? { title: m.title } : {}) } : null };
    edl.meta = { ...(edl.meta || {}), source: allGallery ? 'gallery' : 'camera', limit_s: lim };
    return edl;
  }, []);

  const ensureDraft = useCallback(() => {
    if (!draftIdRef.current || !getDraft(draftIdRef.current)) {
      draftIdRef.current = createDraft(buildEdl(segRef.current));
    }
    return draftIdRef.current;
  }, [buildEdl]);

  const sync = useCallback((segs, immediate = false) => {
    segRef.current = segs;
    setSegments(segs);
    if (!draftIdRef.current) return;
    updateDraft(draftIdRef.current, buildEdl(segs), { immediate });
  }, [buildEdl]);

  // Re-sincroniza quando limite/filtro/música mudam (já com rascunho).
  useEffect(() => {
    if (draftIdRef.current && segRef.current.length) updateDraft(draftIdRef.current, buildEdl(segRef.current));
  }, [limitS, filter, music, buildEdl]);

  /** Adiciona um segmento. `move` = arquivo temporário da câmera (move em vez de copiar). Retorna { index, clip }. */
  const addSegment = useCallback(async (clip, { move = false } = {}) => {
    const id = ensureDraft();
    let uri = clip.uri;
    if (Platform.OS !== 'web') {
      uri = await adoptFile(id, clip.uri, { move, ext: clip.kind === 'image' ? undefined : 'mp4' });
    }
    const c = makeClip({ ...clip, uri });
    const segs = [...segRef.current, c];
    sync(segs, true);
    return { index: segs.length - 1, clip: c };
  }, [ensureDraft, sync]);

  /** Atualiza um segmento (ex.: duração real após probe). */
  const patchSegment = useCallback((index, patch) => {
    const cur = segRef.current;
    if (!cur[index]) return;
    const segs = cur.slice();
    segs[index] = makeClip({ ...cur[index], ...patch });
    sync(segs);
  }, [sync]);

  const removeLast = useCallback(async () => {
    const cur = segRef.current;
    if (!cur.length) return null;
    const last = cur[cur.length - 1];
    sync(cur.slice(0, -1), true);
    if (draftIdRef.current) removeDraftFile(draftIdRef.current, last.uri).catch(() => {});
    return last;
  }, [sync]);

  /** Fecha a sessão: grava a EDL final e devolve o id do rascunho (ou null se vazia/inválida). */
  const finish = useCallback(async () => {
    const segs = segRef.current;
    if (!segs.length) return { id: null, errors: ['empty'] };
    const id = ensureDraft();
    const edl = buildEdl(segs);
    const v = validate(edl);
    updateDraft(id, edl, { immediate: true });
    await saveDraftNow(id);
    return { id, edl, errors: v.ok ? [] : v.errors };
  }, [ensureDraft, buildEdl]);

  const discard = useCallback(async () => {
    const id = draftIdRef.current;
    draftIdRef.current = null;
    segRef.current = [];
    setSegments([]);
    if (id) await deleteDraft(id);
  }, []);

  const keepDraft = useCallback(async () => {
    if (draftIdRef.current) await saveDraftNow(draftIdRef.current);
  }, []);

  /** Re-lê os clips do store (ex.: voltou do editor, que pode ter aparado/reordenado). */
  const reloadFromStore = useCallback(() => {
    const id = draftIdRef.current;
    const d = id ? getDraft(id) : null;
    if (!d) return;
    const clips = Array.isArray(d.edl?.clips) ? d.edl.clips : [];
    segRef.current = clips;
    setSegments(clips);
    if (d.edl?.audio && (d.edl.audio.music || null) !== stateRef.current.music) setMusic(d.edl.audio.music || null);
  }, []);

  const totalS = edlDuration({ clips: segments });

  return {
    segments, totalS, limitS, setLimitS, filter, setFilter, music, setMusic, restored,
    addSegment, patchSegment, removeLast, finish, discard, keepDraft, reloadFromStore,
    getDraftId: () => draftIdRef.current,
  };
}

/** Assets do expo-image-picker → clips (foto = 3 s). */
export function assetsToClips(assets) {
  return (assets || []).map((a) => {
    const isImage = a.type === 'image' || (!a.type && /\.(jpe?g|png|heic|webp|gif)$/i.test(a.uri || ''));
    if (isImage) {
      return { uri: a.uri, kind: 'image', in: 0, out: IMAGE_CLIP_SECONDS, speed: 1, mirror: false, camera: 'gallery', w: a.width, h: a.height };
    }
    const d = a.duration ? a.duration / 1000 : 0; // ImagePicker: ms
    return { uri: a.uri, kind: 'video', in: 0, out: d > 0 ? d : 0.1, speed: 1, mirror: false, camera: 'gallery', w: a.width, h: a.height, _needsProbe: !(d > 0) };
  });
}

/**
 * Lê duração real + miniatura de um vídeo (expo-video). Nunca lança; timeout 3.5 s.
 * thumbAt: segundos (default: fim − 0.12 → "último frame" p/ o modo Alinhar).
 */
export async function probeVideo(uri, { thumbAt, wantThumb = true, timeoutMs = 3500 } = {}) {
  let player = null;
  try {
    const { createVideoPlayer } = require('expo-video');
    player = createVideoPlayer({ uri });
    try { player.muted = true; } catch {}
    const t0 = Date.now();
    let dur = 0;
    while (Date.now() - t0 < timeoutMs) {
      dur = Number(player.duration) || 0;
      if (dur > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    let thumb = null;
    if (wantThumb) {
      const at = thumbAt != null ? thumbAt : Math.max(0, dur - 0.12);
      try {
        const arr = await player.generateThumbnailsAsync([at], { maxWidth: 720, maxHeight: 1280 });
        thumb = arr && arr[0] ? arr[0] : null;
      } catch {}
    }
    return { duration: dur, thumb };
  } catch {
    return { duration: 0, thumb: null };
  } finally {
    try { player?.release?.(); } catch {}
  }
}
