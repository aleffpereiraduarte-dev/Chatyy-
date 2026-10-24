// [2026-10-13 video-studio] Rascunhos do Video Studio (câmera → editor → publicar).
//
// Store em memória (rápido, síncrono p/ a UI) + persistência durável:
//   - AsyncStorage: índice  'vstudio:drafts:v1'  = [{ id, updatedAt, duration, clips, thumb }]
//                   corpo   'vstudio:draft:<id>' = { id, edl, createdAt, updatedAt, status }
//   - Arquivos: <documentDirectory>/video-studio/<id>/  (segmentos gravados / importados)
//     → cacheDirectory pode ser limpo pelo SO; documentDirectory não. App fechado = rascunho intacto.
// Web: sem FS; só AsyncStorage (blob: URLs morrem ao recarregar — o rascunho fica, mas sem mídia).
//
// API (usada pela câmera e pelo editor):
//   createDraft(edl?) → id               getDraft(id) → {id, edl, …} | null (memória)
//   loadDraft(id) → Promise<draft|null>  updateDraft(id, edl) (debounce p/ disco) · saveDraftNow(id)
//   listDrafts() → Promise<index[]>      deleteDraft(id) (apaga arquivos)
//   subscribe(id, fn) → unsubscribe      draftDir(id) → 'file://…/' | null
//   adoptFile(id, uri, {move, ext}) → Promise<uri durável>
//   setPendingMusic(m) / peekPendingMusic() / takePendingMusic()
//     ↳ hook de música: o seletor de música (editor/servidor) chama setPendingMusic({id,url,start,title,volume})
//       antes de abrir a câmera (ou a câmera lê ?music_id=&music_url=&music_start=&music_title=).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { duration as edlDuration, newEdl, cloneEdl } from './edl';
import { rebaseDocUri } from '../durablePath';

let FS = null;
if (Platform.OS !== 'web') {
  try { FS = require('expo-file-system/legacy'); } catch { FS = null; }
}

const INDEX_KEY = 'vstudio:drafts:v1';
const BODY_KEY = (id) => `vstudio:draft:${id}`;
const MAX_DRAFTS = 30;

const mem = new Map();          // id → draft
const subs = new Map();         // id → Set<fn>
const timers = new Map();       // id → debounce timer
let pendingMusic = null;

function genId() {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function draftDir(id) {
  if (!FS || !FS.documentDirectory || !id) return null;
  return `${FS.documentDirectory}video-studio/${id}/`;
}

async function ensureDir(id) {
  const dir = draftDir(id);
  if (!dir) return null;
  try {
    const info = await FS.getInfoAsync(dir);
    if (!info.exists) await FS.makeDirectoryAsync(dir, { intermediates: true });
  } catch {}
  return dir;
}

function emit(id) {
  const set = subs.get(id);
  if (!set) return;
  const d = mem.get(id) || null;
  set.forEach((fn) => { try { fn(d); } catch {} });
}

export function subscribe(id, fn) {
  if (!subs.has(id)) subs.set(id, new Set());
  subs.get(id).add(fn);
  return () => { try { subs.get(id)?.delete(fn); } catch {} };
}

export function createDraft(edl) {
  const id = genId();
  const now = Date.now();
  const d = { id, edl: edl ? cloneEdl(edl) : newEdl(), createdAt: now, updatedAt: now, status: 'draft' };
  mem.set(id, d);
  scheduleSave(id, 0);
  return id;
}

export function getDraft(id) {
  return mem.get(id) || null;
}

// [2026-10-23 reels-sumiu] iOS troca o UUID do container a cada atualização do app
// (TestFlight 773→774): os file:// absolutos do rascunho apontavam p/ a pasta velha →
// vídeo "sumia" (prévia preta, upload tamanho 0). Re-aponta p/ o documentDirectory atual.
const MARK = 'video-studio/';
export function rebaseEdl(edl) {
  if (!edl || typeof edl !== 'object') return edl;
  let changed = false;
  const rb = (u) => { const n = rebaseDocUri(u, MARK); if (n !== u) changed = true; return n; };
  const clips = (edl.clips || []).map((c) => (c && (c.uri || c.thumb) ? { ...c, uri: rb(c.uri), ...(c.thumb ? { thumb: rb(c.thumb) } : null) } : c));
  const audio = edl.audio && edl.audio.voiceover && edl.audio.voiceover.uri
    ? { ...edl.audio, voiceover: { ...edl.audio.voiceover, uri: rb(edl.audio.voiceover.uri) } } : edl.audio;
  const overlays = (edl.overlays || []).map((o) => (o && o.sticker_url ? { ...o, sticker_url: rb(o.sticker_url) } : o));
  return changed ? { ...edl, clips, audio, overlays } : edl;
}

export async function loadDraft(id) {
  if (!id) return null;
  if (mem.has(id)) return mem.get(id);
  try {
    const raw = await AsyncStorage.getItem(BODY_KEY(id));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !d.edl) return null;
    const edl = rebaseEdl(d.edl);
    const nd = edl === d.edl ? d : { ...d, edl };
    mem.set(id, nd);
    if (nd !== d) scheduleSave(id, 0);
    return nd;
  } catch { return null; }
}

/** Substitui a EDL (ou faz merge raso se `patch` for função: patch(edlAtual) → nova). */
export function updateDraft(id, edlOrFn, opts = {}) {
  const d = mem.get(id);
  if (!d) return null;
  const next = typeof edlOrFn === 'function' ? edlOrFn(d.edl) : edlOrFn;
  if (!next) return d;
  const nd = { ...d, edl: next, updatedAt: Date.now(), ...(opts.status ? { status: opts.status } : {}) };
  mem.set(id, nd);
  emit(id);
  scheduleSave(id, opts.immediate ? 0 : 400);
  return nd;
}

function scheduleSave(id, ms) {
  try { clearTimeout(timers.get(id)); } catch {}
  timers.set(id, setTimeout(() => { timers.delete(id); persist(id); }, ms));
}

export async function saveDraftNow(id) {
  try { clearTimeout(timers.get(id)); } catch {}
  timers.delete(id);
  return persist(id);
}

async function persist(id) {
  const d = mem.get(id);
  if (!d) return false;
  try {
    await AsyncStorage.setItem(BODY_KEY(id), JSON.stringify(d));
    const idx = await readIndex();
    const firstClip = d.edl?.clips?.[0];
    const entry = {
      id,
      updatedAt: d.updatedAt,
      createdAt: d.createdAt,
      duration: edlDuration(d.edl),
      clips: d.edl?.clips?.length || 0,
      thumb: firstClip?.thumb || (firstClip?.kind === 'image' ? firstClip.uri : null),
      status: d.status || 'draft',
    };
    const next = [entry, ...idx.filter((x) => x && x.id !== id)].slice(0, MAX_DRAFTS);
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(next));
    // Rascunhos que caíram do índice (cap) são apagados de verdade.
    const dropped = [entry, ...idx.filter((x) => x && x.id !== id)].slice(MAX_DRAFTS);
    dropped.forEach((x) => { deleteDraft(x.id).catch(() => {}); });
    return true;
  } catch { return false; }
}

async function readIndex() {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export async function listDrafts() {
  const idx = (await readIndex()).map((x) => (x && x.thumb ? { ...x, thumb: rebaseDocUri(x.thumb, MARK) } : x));
  return idx.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deleteDraft(id) {
  if (!id) return;
  try { clearTimeout(timers.get(id)); } catch {}
  timers.delete(id);
  mem.delete(id);
  emit(id);
  try { await AsyncStorage.removeItem(BODY_KEY(id)); } catch {}
  try {
    const idx = await readIndex();
    await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(idx.filter((x) => x && x.id !== id)));
  } catch {}
  const dir = draftDir(id);
  if (dir) { try { await FS.deleteAsync(dir, { idempotent: true }); } catch {} }
}

/**
 * Copia/move um arquivo p/ a pasta durável do rascunho. Retorna a nova uri
 * (ou a original se não der — web, content://, falha de disco).
 */
export async function adoptFile(id, uri, { move = false, ext } = {}) {
  if (!FS || !uri || !/^file:/i.test(uri)) return uri;
  const dir = await ensureDir(id);
  if (!dir) return uri;
  if (uri.startsWith(dir)) return uri;
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(uri);
  const e = (ext || (m && m[1]) || 'mp4').toLowerCase();
  const dest = `${dir}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${e}`;
  try {
    if (move) await FS.moveAsync({ from: uri, to: dest });
    else await FS.copyAsync({ from: uri, to: dest });
    return dest;
  } catch {
    if (move) {
      try { await FS.copyAsync({ from: uri, to: dest }); return dest; } catch {}
    }
    return uri;
  }
}

/** Remove um arquivo do rascunho (ex.: "apagar último segmento"). Só apaga dentro da pasta do rascunho. */
export async function removeDraftFile(id, uri) {
  const dir = draftDir(id);
  if (!dir || !uri || !uri.startsWith(dir)) return;
  try { await FS.deleteAsync(uri, { idempotent: true }); } catch {}
}

// ── Hook de música (editor/servidor → câmera) ───────────────────────────────
export function setPendingMusic(m) { pendingMusic = m && (m.url || m.id) ? { ...m } : null; }
export function peekPendingMusic() { return pendingMusic; }
export function takePendingMusic() { const m = pendingMusic; pendingMusic = null; return m; }

export default {
  createDraft, getDraft, loadDraft, updateDraft, saveDraftNow, listDrafts, deleteDraft,
  subscribe, draftDir, adoptFile, removeDraftFile, setPendingMusic, peekPendingMusic, takePendingMusic,
};
