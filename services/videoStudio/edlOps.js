// [2026-10-13 video-studio] Operações puras sobre a EDL v1 (editor).
//
// Tudo IMUTÁVEL: cada função devolve uma NOVA EDL (seguro p/ setState/undo).
// Tempos: "t" = tempo da timeline (segundos, já com velocidade);
//         clip.in/out = tempo-fonte (segundos da mídia, antes da velocidade).
//
// Extensões OPCIONAIS usadas pelo editor (documentadas em edl.js → "Extensões"):
//   overlay.id            — id estável p/ chave de UI (servidor ignora).
//   overlay.kind          — "gif" quando a figurinha é GIF animado (informativo).
//   audio.music.title / artist / cover / duration — só exibição.
//   captions.segments     — [{start,end,text}] (tempo da timeline) editados pelo usuário.
import { clipDuration, duration as edlDuration, makeClip, cloneEdl } from './edl';

export const MIN_CLIP_S = 0.3;
export const MIN_OVERLAY_S = 0.3;
export const DEFAULT_OVERLAY_S = 3;

const r3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function totalDuration(edl) { return edlDuration(edl); }

/** Início (tempo de timeline) de cada clip. */
export function clipStarts(edl) {
  const out = [];
  let acc = 0;
  for (const c of edl?.clips || []) { out.push(acc); acc += clipDuration(c); }
  return out;
}

/** t (timeline) → { index, local (tempo-fonte), offset (seg dentro do clip na timeline) }. */
export function locate(edl, t) {
  const clips = edl?.clips || [];
  if (!clips.length) return { index: -1, local: 0, offset: 0 };
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const d = clipDuration(clips[i]);
    if (t < acc + d || i === clips.length - 1) {
      const off = clamp(t - acc, 0, d);
      const sp = clips[i].speed || 1;
      return { index: i, local: clips[i].in + off * sp, offset: off };
    }
    acc += d;
  }
  return { index: clips.length - 1, local: clips[clips.length - 1].out, offset: 0 };
}

function withClips(edl, clips) { return { ...edl, clips }; }

export function updateClip(edl, i, patch) {
  const clips = [...(edl.clips || [])];
  if (!clips[i]) return edl;
  clips[i] = { ...clips[i], ...patch };
  return clampOverlays(withClips(edl, clips));
}

/** Aparar: novos in/out (tempo-fonte), mínimo MIN_CLIP_S·speed, limitado a [0, srcDur]. */
export function setTrim(edl, i, inS, outS, srcDur) {
  const c = edl.clips?.[i];
  if (!c) return edl;
  const sp = c.speed || 1;
  const max = srcDur > 0 ? srcDur : (c.kind === 'image' ? 3600 : Math.max(c.out, outS));
  let a = clamp(inS, 0, max);
  let b = clamp(outS, 0, max);
  if (b - a < MIN_CLIP_S * sp) {
    if (inS !== c.in) a = Math.max(0, b - MIN_CLIP_S * sp); else b = Math.min(max, a + MIN_CLIP_S * sp);
  }
  return updateClip(edl, i, { in: r3(a), out: r3(b) });
}

/** Divide o clip sob o cursor em t. Não divide se ficar < MIN_CLIP_S de um lado. */
export function splitAt(edl, t) {
  const { index, local } = locate(edl, t);
  if (index < 0) return edl;
  const c = edl.clips[index];
  const sp = c.speed || 1;
  if ((local - c.in) / sp < MIN_CLIP_S || (c.out - local) / sp < MIN_CLIP_S) return edl;
  const a = { ...c, out: r3(local) };
  const b = { ...c, in: r3(local) };
  const clips = [...edl.clips];
  clips.splice(index, 1, a, b);
  return withClips(edl, clips);
}

export function removeClip(edl, i) {
  if (!edl.clips?.[i] || edl.clips.length <= 1) return edl;
  const clips = edl.clips.filter((_, k) => k !== i);
  return clampOverlays(withClips(edl, clips));
}

export function moveClip(edl, from, to) {
  const n = edl.clips?.length || 0;
  if (from === to || from < 0 || from >= n) return edl;
  const clips = [...edl.clips];
  const [c] = clips.splice(from, 1);
  clips.splice(clamp(to, 0, n - 1), 0, c);
  return withClips(edl, clips);
}

export function duplicateClip(edl, i) {
  const c = edl.clips?.[i];
  if (!c) return edl;
  const clips = [...edl.clips];
  clips.splice(i + 1, 0, { ...c });
  return withClips(edl, clips);
}

export function appendClips(edl, list) {
  const clips = [...(edl.clips || []), ...list.map(makeClip)];
  return withClips(edl, clips);
}

// ─── Overlays ───────────────────────────────────────────────────────────────
let _seq = 0;
export function newOverlayId() { _seq += 1; return `o${Date.now().toString(36)}${_seq}`; }

/** Garante id em todos os overlays (EDLs vindas da câmera/servidor podem não ter). */
export function ensureOverlayIds(edl) {
  const ov = edl?.overlays || [];
  if (ov.every((o) => o && o.id)) return edl;
  return { ...edl, overlays: ov.map((o) => (o && o.id ? o : { ...o, id: newOverlayId() })) };
}

export function addOverlay(edl, o, at = 0) {
  const total = edlDuration(edl);
  const start = clamp(at, 0, Math.max(0, total - MIN_OVERLAY_S));
  const end = Math.min(total, start + DEFAULT_OVERLAY_S) || start + DEFAULT_OVERLAY_S;
  const ov = {
    id: newOverlayId(),
    type: o.type === 'sticker' ? 'sticker' : 'text',
    text: o.text || '',
    sticker_url: o.sticker_url || '',
    start: r3(start),
    end: r3(Math.max(end, start + MIN_OVERLAY_S)),
    x: 0.5, y: 0.42, scale: 1, rotation: 0,
    style: { font: 'classic', color: '#FFFFFF', bg: 'none', align: 'center', ...(o.style || {}) },
    ...(o.kind ? { kind: o.kind } : {}),
  };
  return { ...edl, overlays: [...(edl.overlays || []), ov] };
}

export function updateOverlay(edl, id, patch) {
  return {
    ...edl,
    overlays: (edl.overlays || []).map((o) => (o.id === id ? { ...o, ...patch, style: patch.style ? { ...o.style, ...patch.style } : o.style } : o)),
  };
}

export function removeOverlay(edl, id) {
  return { ...edl, overlays: (edl.overlays || []).filter((o) => o.id !== id) };
}

export function setOverlayRange(edl, id, start, end) {
  const total = edlDuration(edl);
  let a = clamp(start, 0, total);
  let b = clamp(end, 0, total);
  if (b - a < MIN_OVERLAY_S) b = Math.min(total, a + MIN_OVERLAY_S);
  if (b - a < MIN_OVERLAY_S) a = Math.max(0, b - MIN_OVERLAY_S);
  return updateOverlay(edl, id, { start: r3(a), end: r3(b) });
}

/** Overlays/legendas/capa nunca passam do fim depois de aparar/apagar. */
export function clampOverlays(edl) {
  const total = edlDuration(edl);
  if (!(total > 0)) return edl;
  const overlays = (edl.overlays || [])
    .map((o) => {
      const s = Math.min(o.start, Math.max(0, total - MIN_OVERLAY_S));
      const e = clamp(o.end, s + MIN_OVERLAY_S, total);
      return (s === o.start && e === o.end) ? o : { ...o, start: r3(s), end: r3(e) };
    });
  const cover = edl.cover && edl.cover.t > total ? { ...edl.cover, t: r3(Math.max(0, total - 0.1)) } : edl.cover;
  return { ...edl, overlays, cover };
}

export function visibleOverlays(edl, t) {
  return (edl?.overlays || []).filter((o) => t >= o.start && t < o.end);
}

// ─── Upload / servidor ──────────────────────────────────────────────────────
export function isLocalUri(u) {
  return typeof u === 'string' && /^(file|content|ph|assets-library|blob|data):/i.test(u);
}

/** Lista de URIs locais que precisam subir antes do render (sem duplicatas). */
export function localAssets(edl) {
  const set = new Map();
  (edl?.clips || []).forEach((c) => { if (isLocalUri(c.uri)) set.set(c.uri, { uri: c.uri, kind: c.kind === 'image' ? 'image' : 'video' }); });
  const vo = edl?.audio?.voiceover;
  if (vo && isLocalUri(vo.uri)) set.set(vo.uri, { uri: vo.uri, kind: 'audio' });
  (edl?.overlays || []).forEach((o) => { if (o.type === 'sticker' && isLocalUri(o.sticker_url)) set.set(o.sticker_url, { uri: o.sticker_url, kind: 'image' }); });
  return [...set.values()];
}

/** EDL para o servidor: troca URIs locais pelas remotas e tira campos só-cliente. */
export function toRemoteEdl(edl, urlMap) {
  const e = cloneEdl(edl);
  const m = (u) => (urlMap && urlMap[u]) || u;
  e.clips = (e.clips || []).map((c) => { const x = { ...c, uri: m(c.uri) }; delete x.thumb; return x; });
  if (e.audio?.voiceover) e.audio.voiceover = { ...e.audio.voiceover, uri: m(e.audio.voiceover.uri) };
  e.overlays = (e.overlays || []).map((o) => (o.type === 'sticker' ? { ...o, sticker_url: m(o.sticker_url) } : o));
  return e;
}

/** Sem edição além de cortar/juntar → dá p/ publicar pelo caminho antigo (feed_create_post). */
export function isPlainEdl(edl) {
  const clips = edl?.clips || [];
  if (!clips.length) return false;
  if (clips.some((c) => (c.speed || 1) !== 1 || c.mirror || c.kind === 'image')) return false;
  if (clips.length > 1 && clips.some((c, i) => c.in > 0.05)) return false; // legado não corta por clip
  if ((edl.overlays || []).length) return false;
  if (edl.filter && edl.filter.id && edl.filter.id !== 'none') return false;
  if (edl.audio?.music || edl.audio?.voiceover) return false;
  if ((edl.audio?.original_volume ?? 1) !== 1) return false;
  if (edl.captions?.enabled) return false;
  return true;
}

export function fmtTime(s) {
  const v = Math.max(0, s || 0);
  const m = Math.floor(v / 60);
  const ss = Math.floor(v % 60);
  return `${m}:${ss < 10 ? '0' : ''}${ss}`;
}

export function fmtTimePrecise(s) {
  const v = Math.max(0, s || 0);
  return `${fmtTime(v)}.${Math.floor((v % 1) * 10)}`;
}
