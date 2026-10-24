// [2026-10-13 video-studio] Fila de publicação do Video Studio (2º plano, durável).
//
// "Publicar" no /video-studio/publish entrega a EDL a esta fila e a tela fecha:
//   1) upload dos arquivos LOCAIS da EDL (clips, voz, figurinhas locais) com
//      paralelismo limitado (2) e retomável: o id de sessão do upload Rust e a
//      URL final de cada arquivo ficam persistidos (cache uri → url, também
//      reaproveitado pelas Legendas automáticas, que sobem os clips antes);
//   2) reels_render_submit { edl (URLs remotas), publish, client_job_id } —
//      client_job_id = id do job → reenvio após resposta perdida não duplica;
//   3) acompanha reels_render_status até done/failed (sondagem com recuo; volta
//      sozinha ao reabrir o app — job_id persistido; tarefa de background-fetch
//      chama pollStudioRendersInBackground());
//   4) pronto → aviso para Reels/Feed/Perfil (reelPublishQueue.emitReelPublished),
//      notificação local se o app não estiver em primeiro plano, salvar no
//      aparelho (opcional) e apaga o rascunho.
// Fallback: servidor sem reels_render_submit + EDL sem edição → feed_create_post (caminho antigo).
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as S from './studioApi';
import { localAssets, toRemoteEdl, isPlainEdl, isLocalUri } from './edlOps';
import { duration as edlDuration } from './edl';
import { vsDiag } from './diag';

const STORE_KEY = 'vstudio_render_jobs_v1';
const CACHE_KEY = 'vstudio_upload_cache_v1';
const MAX_ATTEMPTS = 8;
const PARALLEL = 2;
const UPLOAD_SHARE = 0.6; // 0..60 % = upload; 60..100 % = render

const _jobs = new Map();
const _subs = new Set();
let _running = null;
let _loaded = false;
let _cache = null; // { [uri]: { url, rustUploadId, at } }
let _appStateSub = null;

function _FS() { if (Platform.OS === 'web') return null; try { return require('expo-file-system/legacy'); } catch { return null; } }
function _bgMod() { try { const m = require('../../modules/expo-background-upload'); return m?.default || m; } catch { return null; } }
function _beginBg() {
  if (Platform.OS !== 'ios') return null;
  try { const m = _bgMod(); if (m?.beginBackgroundTask) { const id = m.beginBackgroundTask('chatyy-studio-render'); return (typeof id === 'number' && id >= 0) ? id : null; } } catch {}
  return null;
}
function _endBg(id) { if (id == null) return; try { _bgMod()?.endBackgroundTask?.(id); } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function newStudioJobId() {
  return `vs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Leitura / assinatura ───────────────────────────────────────────────────
function _snap(j) {
  return {
    id: j.id,
    kind: 'studio',
    email: j.email,
    status: j.status, // queued | uploading | publishing | done | failed
    phase: j.phase || null, // upload | submit | render
    progress: j.progress || 0,
    error: j.error || null,
    caption: j.publish?.caption || '',
    coverUri: j.coverUri || null,
    post: j.post || null,
    createdAt: j.createdAt,
    draftId: j.draftId || null,
  };
}
export function getStudioJobs(email) {
  const out = [];
  for (const j of _jobs.values()) {
    if (email && j.email && j.email !== String(email).toLowerCase()) continue;
    out.push(_snap(j));
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
export function isDraftPublishing(draftId) {
  for (const j of _jobs.values()) if (j.draftId === draftId && j.status !== 'done' && j.status !== 'failed') return true;
  return false;
}
export function subscribeStudioJobs(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => _subs.delete(fn);
}
let _lastEmit = 0;
function _emit(force) {
  const now = Date.now();
  if (!force && now - _lastEmit < 150) return;
  _lastEmit = now;
  for (const fn of _subs) { try { fn(); } catch {} }
}

// ─── Persistência ───────────────────────────────────────────────────────────
async function _persist() {
  try {
    const list = [];
    for (const j of _jobs.values()) {
      if (j.status === 'done') continue;
      if (Platform.OS === 'web' && j.status !== 'publishing') continue; // blob: morre com a aba
      const { ctrl, ...rest } = j;
      list.push(rest);
    }
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {}
}
async function _load() {
  if (_loaded) return;
  _loaded = true;
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (Array.isArray(list)) {
      for (const j of list) {
        if (!j?.id || _jobs.has(j.id)) continue;
        if (j.status === 'uploading') j.status = 'queued';
        j.attempts = 0;
        // [2026-10-23 reels-sumiu] container do iOS muda na atualização → re-aponta os arquivos locais.
        if (j.edl && !j.serverJobId) { try { j.edl = require('./draftStore').rebaseEdl(j.edl); } catch {} }
        _jobs.set(j.id, j);
      }
    }
  } catch {}
  if (!_appStateSub) {
    try {
      _appStateSub = AppState.addEventListener('change', (s) => {
        if (s !== 'active') return;
        for (const j of _jobs.values()) if (j.status === 'publishing' && j.serverJobId) j.retryAt = 0;
        _kick();
      });
    } catch {}
  }
}

async function _loadCache() {
  if (_cache) return _cache;
  try { const raw = await AsyncStorage.getItem(CACHE_KEY); _cache = raw ? JSON.parse(raw) || {} : {}; } catch { _cache = {}; }
  // limpa entradas com mais de 3 dias (URLs ainda valem, mas evita crescer sem fim)
  const lim = Date.now() - 3 * 86400000;
  Object.keys(_cache).forEach((k) => { if (!_cache[k] || (_cache[k].at || 0) < lim) delete _cache[k]; });
  return _cache;
}
let _cacheTimer = null;
function _saveCache() {
  if (_cacheTimer) return;
  _cacheTimer = setTimeout(() => { _cacheTimer = null; AsyncStorage.setItem(CACHE_KEY, JSON.stringify(_cache || {})).catch(() => {}); }, 300);
}

async function _sizeOf(uri) {
  const FS = _FS();
  if (!FS) return 0;
  try { const i = await FS.getInfoAsync(uri); return i?.size || 0; } catch { return 0; }
}

/**
 * Sobe os arquivos locais de uma EDL (paralelo limitado, retomável). Usado pela
 * fila e pelas Legendas automáticas. → { ok, map: {uri→url}, error? }
 */
export async function uploadEdlAssets(edl, email, { onProgress, signal, onlyUris } = {}) {
  const cache = await _loadCache();
  let assets = localAssets(edl);
  if (onlyUris) assets = assets.filter((a) => onlyUris.includes(a.uri));
  const map = {};
  const todo = [];
  for (const a of assets) {
    if (cache[a.uri]?.url) map[a.uri] = cache[a.uri].url;
    else todo.push(a);
  }
  if (!todo.length) { onProgress?.(1); return { ok: true, map }; }
  const sizes = await Promise.all(todo.map((a) => _sizeOf(a.uri)));
  const total = sizes.reduce((s, v) => s + Math.max(1, v), 0);
  const prog = todo.map(() => 0);
  const report = () => onProgress?.(todo.reduce((s, _, i) => s + prog[i] * Math.max(1, sizes[i]), 0) / total);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (!failure && next < todo.length) {
      const i = next++;
      const a = todo[i];
      if (signal?.aborted) { failure = { error: 'aborted', aborted: true }; return; }
      const file = S.fileDescriptor({ ...a, size: sizes[i] }, i);
      if (Platform.OS === 'web' && /^blob:/i.test(a.uri)) {
        try { file._raw = await fetch(a.uri).then((r) => r.blob()); file.size = file._raw.size; } catch {}
      }
      const ent = cache[a.uri] || {};
      const resume = Platform.OS === 'web' ? null : {
        uploadId: ent.rustUploadId || null,
        onUploadId: (uid) => { cache[a.uri] = { ...(cache[a.uri] || {}), rustUploadId: uid, at: Date.now() }; _saveCache(); },
      };
      const r = await S.uploadAsset(file, email, { onProgress: (f) => { prog[i] = Math.max(0, Math.min(1, Number(f) || 0)); report(); }, signal, resume });
      if (!r.ok) { failure = r; return; }
      cache[a.uri] = { url: r.url, at: Date.now() };
      _saveCache();
      map[a.uri] = r.url;
      prog[i] = 1;
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
  if (failure) return { ok: false, error: failure.error || 'upload_failed', hard: !!failure.hard, aborted: !!failure.aborted };
  return { ok: true, map };
}

// ─── Enfileirar / controle ──────────────────────────────────────────────────
/**
 * enqueueStudioRender({ email, draftId, edl, publish:{caption,hashtags,visibility,allow_comments,allow_duet,cover_t},
 *                       coverUri?, saveToDevice? }) → id
 */
export async function enqueueStudioRender(input) {
  await _load();
  const id = input?.id || newStudioJobId();
  const job = {
    id,
    email: String(input?.email || '').toLowerCase(),
    createdAt: Date.now(),
    status: 'queued',
    phase: 'upload',
    progress: 0,
    attempts: 0,
    error: null,
    draftId: input?.draftId || null,
    coverUri: input?.coverUri || null,
    edl: input.edl,
    publish: input.publish || {},
    saveToDevice: !!input?.saveToDevice,
    serverJobId: null,
    urlMap: {},
  };
  if (!job.edl?.clips?.length) throw new Error('no_clips');
  vsDiag('enqueue', { n: job.edl.clips.length, mus: job.edl.audio?.music ? 1 : 0, vis: job.publish?.visibility });
  _jobs.set(id, job);
  _emit(true);
  await _persist();
  _kick();
  return id;
}

export function retryStudioRender(id) {
  const j = _jobs.get(id);
  if (!j || j.status === 'done') return;
  j.status = j.serverJobId && j.lastState !== 'failed' ? 'publishing' : 'queued';
  if (j.lastState === 'failed') { j.serverJobId = null; j.phase = 'submit'; j.lastState = null; j.submitSeq = (j.submitSeq || 0) + 1; }
  j.error = null;
  j.attempts = 0;
  _emit(true);
  _persist();
  _kick();
}

export async function cancelStudioRender(id) {
  const j = _jobs.get(id);
  if (!j) return;
  j.cancelled = true;
  try { j.ctrl?.abort(); } catch {}
  _jobs.delete(id);
  _emit(true);
  await _persist();
  // Rascunho continua existindo (status volta a 'draft').
  if (j.draftId) {
    try {
      const ds = require('./draftStore');
      await ds.loadDraft(j.draftId);
      ds.updateDraft(j.draftId, (e) => e, { status: 'draft', immediate: true });
    } catch {}
  }
}

export function dismissStudioJob(id) {
  const j = _jobs.get(id);
  if (j && j.status === 'done') { _jobs.delete(id); _emit(true); }
}

export async function resumeStudioRenders() {
  await _load();
  _emit(true);
  _kick();
}

// ─── Worker ─────────────────────────────────────────────────────────────────
function _kick() {
  if (_running) return;
  const now = Date.now();
  const next = [..._jobs.values()]
    .filter((j) => (j.status === 'queued' || j.status === 'publishing' || j.status === 'uploading') && !(j.retryAt > now))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) return;
  _running = next.id;
  _run(next).catch(() => {}).finally(() => { _running = null; setTimeout(_kick, 50); });
}

function _hard(msg) { return /invalid|required|not your|dangerous|too large|413|415|403|edl/i.test(String(msg || '')); }

async function _run(job) {
  job.ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const bg = _beginBg();
  try {
    // 1) Upload
    if (!job.serverJobId) {
      job.status = 'uploading';
      job.phase = 'upload';
      job.error = null;
      _emit(true);
      const up = await uploadEdlAssets(job.edl, job.email, {
        signal: job.ctrl?.signal,
        onProgress: (f) => { job.progress = Math.min(UPLOAD_SHARE, f * UPLOAD_SHARE); _emit(); },
      });
      if (job.cancelled) return;
      vsDiag(up.ok ? 'up_ok' : 'up_fail', { n: (job.edl?.clips || []).length, a: job.attempts || 0, e: up.ok ? '' : String(up.error || '').slice(0, 40) });
      if (!up.ok) throw Object.assign(new Error(up.error || 'upload_failed'), { hard: up.hard });
      job.urlMap = up.map;
      job.progress = UPLOAD_SHARE;
      // 2) Submit
      job.status = 'publishing';
      job.phase = 'submit';
      _emit(true);
      const remote = toRemoteEdl(job.edl, job.urlMap);
      const stillLocal = remote.clips.some((c) => isLocalUri(c.uri));
      if (stillLocal) throw new Error('upload_incomplete');
      // client_job_id idempotente; muda só quando o usuário re-tenta um render que FALHOU no servidor.
      const sub = await S.renderSubmit(remote, job.publish, job.submitSeq ? `${job.id}_${job.submitSeq}` : job.id);
      if (job.cancelled) return;
      vsDiag(sub.ok ? 'submit_ok' : 'submit_fail', { e: sub.ok ? '' : String(sub.error || '').slice(0, 40), miss: sub.missing ? 1 : 0 });
      if (!sub.ok) {
        if (sub.missing) {
          // "Só eu" não existe no caminho antigo → nunca cai nele (privacidade).
          if (isPlainEdl(job.edl) && job.publish?.visibility !== 'private') { await _legacyPublish(job, remote); return; }
          throw Object.assign(new Error('render_unavailable'), { hard: true });
        }
        throw Object.assign(new Error(sub.error || 'submit_failed'), { hard: _hard(sub.error) && !sub.network });
      }
      job.serverJobId = sub.jobId;
      job.phase = 'render';
      await _persist();
    }
    // 3) Acompanhar
    job.status = 'publishing';
    job.phase = 'render';
    _emit(true);
    let delay = 1500;
    const started = Date.now();
    for (;;) {
      if (job.cancelled) return;
      const st = await S.renderStatus(job.serverJobId);
      if (job.cancelled) return;
      if (!st.ok) {
        if (st.missing) throw Object.assign(new Error('render_unavailable'), { hard: true });
        throw new Error(st.error || 'status_failed');
      }
      job.lastState = st.state;
      if (st.state === 'done') { await _finish(job, st); return; }
      if (st.state === 'failed') throw Object.assign(new Error(st.error || 'render_failed'), { hard: true, renderFailed: true });
      job.progress = UPLOAD_SHARE + (1 - UPLOAD_SHARE) * Math.min(0.98, st.progress || 0);
      _emit();
      // Em segundo plano (JS ainda vivo) sonda menos; a tarefa de background
      // fetch/reabertura do app continua de onde parou.
      if (AppState.currentState !== 'active' && Date.now() - started > 25000) {
        job.retryAt = Date.now() + 45000;
        setTimeout(() => { if (_jobs.get(job.id) === job) { job.retryAt = 0; _kick(); } }, 45000);
        return;
      }
      await sleep(delay);
      delay = Math.min(6000, Math.round(delay * 1.3));
    }
  } catch (e) {
    if (job.cancelled) return;
    job.attempts = (job.attempts || 0) + 1;
    const msg = e?.message || 'error';
    if (e?.hard || job.attempts >= MAX_ATTEMPTS) {
      vsDiag('job_failed', { e: String(msg).slice(0, 40), a: job.attempts });
      job.status = 'failed';
      job.error = msg;
      _emit(true);
      _persist();
      _notify(job, false);
    } else {
      job.status = job.serverJobId ? 'publishing' : 'queued';
      job.error = msg;
      job.retryAt = Date.now() + Math.min(60000, 2000 * Math.pow(2, job.attempts - 1));
      _emit(true);
      _persist();
      setTimeout(() => { if (_jobs.get(job.id) === job) { job.retryAt = 0; _kick(); } }, Math.max(0, job.retryAt - Date.now()) + 20);
    }
  } finally {
    job.ctrl = null;
    _endBg(bg);
  }
}

async function _legacyPublish(job, remote) {
  const api = require('../api');
  const fd = new FormData();
  const p = job.publish || {};
  fd.append('client_post_id', job.id);
  fd.append('media_type', 'video');
  fd.append('is_reel', '1');
  fd.append('caption', String(p.caption || '').slice(0, 2200));
  if (p.visibility === 'friends') fd.append('audience', 'followers');
  fd.append('allow_comments', p.allow_comments === false ? '0' : '1');
  if (p.cover_t != null) fd.append('cover_ms', String(Math.round((p.cover_t || 0) * 1000)));
  const urls = remote.clips.map((c) => c.uri);
  if (remote.clips.length === 1) {
    const c = remote.clips[0];
    if (c.in > 0) fd.append('trim_start_ms', String(Math.round(c.in * 1000)));
    fd.append('trim_end_ms', String(Math.round(c.out * 1000)));
  }
  fd.append('duration_ms', String(Math.round(edlDuration(remote) * 1000)));
  fd.append('media_url', urls[0]);
  if (urls.length > 1) fd.append('clip_urls', JSON.stringify(urls));
  const r = await api.feedCreatePost(fd);
  if (!r || !r.success) throw Object.assign(new Error((r && (r.error || r.message)) || 'publish_failed'), { hard: _hard(r?.error) });
  const post = r.data?.post || r.data || {};
  await _finish(job, { postId: post.id != null ? String(post.id) : null, url: post.media_url || urls[0], post });
}

async function _finish(job, st) {
  const now = new Date();
  const p = job.publish || {};
  job.post = {
    media_type: 'video',
    likes: 0, likes_count: 0, comments: 0, comments_count: 0, views: 0,
    user_liked: false, user_bookmarked: false, tagged_users: [],
    created_at: now.toISOString(),
    id: st.postId,
    media_url: st.url,
    thumbnail_url: st.cover || null,
    caption: p.caption || '',
    author_email: job.email,
    ...(st.post || {}),
    is_reel: true,
  };
  vsDiag('job_done', { post: job.post?.id ? 1 : 0 });
  job.status = 'done';
  job.phase = null;
  job.progress = 1;
  job.error = null;
  _emit(true);
  await _persist();
  if (job.post.id) { try { require('../reelPublishQueue').emitReelPublished?.(job.post); } catch {} }
  if (job.saveToDevice && st.url) _saveToDevice(st.url).catch(() => {});
  if (job.draftId) { try { await require('./draftStore').deleteDraft(job.draftId); } catch {} }
  _notify(job, true);
  setTimeout(() => { if (_jobs.get(job.id) === job) { _jobs.delete(job.id); _emit(true); } }, 8000);
}

async function _saveToDevice(url) {
  if (Platform.OS === 'web') return;
  const FS = _FS();
  const ML = require('expo-media-library');
  const perm = await ML.requestPermissionsAsync(true);
  if (!perm?.granted) return;
  const dest = `${FS.cacheDirectory}chatyy_reel_${Date.now()}.mp4`;
  const r = await FS.downloadAsync(url, dest);
  if (r?.uri) { await ML.saveToLibraryAsync(r.uri); try { await FS.deleteAsync(r.uri, { idempotent: true }); } catch {} }
}

function _notify(job, ok) {
  if (Platform.OS === 'web') return;
  try {
    if (AppState.currentState === 'active') return;
    const N = require('expo-notifications');
    const L = (() => { try { return require('../../i18n'); } catch { return null; } })();
    const lang = (() => { try { return require('../api')?.getCurrentLanguage?.() || 'pt-BR'; } catch { return 'pt-BR'; } })();
    const tr = (k, fb) => { try { return L?.translations?.[lang]?.[k] ?? L?.translations?.['pt-BR']?.[k] ?? fb; } catch { return fb; } };
    N.scheduleNotificationAsync({
      content: {
        title: ok ? tr('studio.notif.doneTitle', 'Seu vídeo está no ar') : tr('studio.notif.failedTitle', 'Não foi possível publicar o vídeo'),
        body: ok ? tr('studio.notif.doneBody', 'Toque para ver no Reels.') : tr('studio.notif.failedBody', 'Abra o Chatyy para tentar de novo.'),
        data: { type: 'reel_publish', post_id: job.post?.id ? String(job.post.id) : '', route: '/chat?tab=feed' },
      },
      trigger: null,
    }).catch(() => {});
  } catch {}
}

/** Chamado pela tarefa de background fetch: sonda renders pendentes (rápido). */
export async function pollStudioRendersInBackground() {
  await _load();
  let touched = false;
  for (const j of [..._jobs.values()]) {
    if (j.status !== 'publishing' || !j.serverJobId) continue;
    const st = await S.renderStatus(j.serverJobId);
    if (!st.ok) continue;
    touched = true;
    if (st.state === 'done') await _finish(j, st);
    else if (st.state === 'failed') { j.status = 'failed'; j.error = st.error || 'render_failed'; j.lastState = 'failed'; await _persist(); _notify(j, false); }
  }
  return touched;
}

export default {
  enqueueStudioRender, retryStudioRender, cancelStudioRender, dismissStudioJob, resumeStudioRenders,
  getStudioJobs, subscribeStudioJobs, isDraftPublishing, uploadEdlAssets, pollStudioRendersInBackground, newStudioJobId,
};
