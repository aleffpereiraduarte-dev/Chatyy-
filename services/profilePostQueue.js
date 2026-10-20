/**
 * Fila durável de "Publicar no perfil" — [post-perfil 2026-10-20]
 *
 * Por que existe: o compositor esperava o upload terminar com a folha aberta
 * (um único POST multipart com as fotos ORIGINAIS → US), depois mandava a pessoa
 * para o Feed e a grade do perfil continuava na cópia antiga (cache de 2 min do
 * Perfil + SWR do profile_get não eram invalidados) → "deu delay" e a pessoa
 * publicava de novo (20/10: post 134 e 135 iguais, 51 s de diferença).
 *
 * Modelo Instagram:
 *   • enqueueProfilePost() devolve na hora; a folha fecha e o post aparece no topo
 *     da grade do PRÓPRIO perfil com as imagens locais + barrinha de progresso;
 *   • preparo no aparelho: foto recortada no formato escolhido, lado maior 2048 px,
 *     JPEG 0,8 (compressImage do chat quando não há recorte); vídeo pelo
 *     videoSendPipeline do chat + capa gerada no aparelho;
 *   • upload em paralelo (3 de cada vez) pelo Rust/edge mais próximo
 *     (api.rustUpload / rustChunkedUpload com retomada), depois UMA confirmação
 *     feed_create_post com media_urls (o servidor só grava a linha: ~30 ms);
 *   • idempotente: o id do job vai como client_post_id (re-tentar não duplica);
 *   • durável (nativo): jobs no AsyncStorage + arquivos preparados em
 *     documentDirectory/post-outbox/ → sobrevive a fechar o app; retoma no boot;
 *   • falha: "Tentar de novo" no próprio post (grade) e no cartão de progresso;
 *   • telemetria leve (push_diag step=post_pub): preparo / upload / confirmação.
 *
 * Kill switch OTA: globalThis.__chatyy_post_queue = false → compositor antigo
 * (POST multipart único com progresso, sem fila).
 *
 * [mural 2026-10-20] Também post SÓ TEXTO (items vazio + caption): pula preparo/
 * upload e vai direto à confirmação. Público public|contacts|private (contrato
 * /root/mural-2026-10-20/API.md; "everyone" continua aceito) e media_meta (w/h/
 * capa) para a grade/visualizador acertarem o formato sem baixar a foto.
 */
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORE_KEY = 'profile_post_jobs_v1';
const OUTBOX_DIR = 'post-outbox/';
const MAX_ATTEMPTS = 8;
const UPLOAD_CONCURRENCY = 3;
const IMAGE_MAX_DIM = 2048;
const IMAGE_QUALITY = 0.8;
const VIDEO_COMPRESS_MIN_BYTES = 2 * 1024 * 1024;
export const POSTS_CHANGED_EVENT = 'chatyy:profilePostsChanged';

const _jobs = new Map(); // id -> job
const _subs = new Set();
const _publishedSubs = new Set();
let _running = null;
let _wakeTimer = null;
let _loadedFor = null;
let _appStateSub = null;

export function isProfilePostQueueEnabled() {
  try { if (globalThis.__chatyy_post_queue === false) return false; } catch {}
  return true;
}

function _api() { try { return require('./api'); } catch { return null; } }
function _FS() { if (Platform.OS === 'web') return null; try { return require('expo-file-system/legacy'); } catch { return null; } }
function _bgMod() { try { const m = require('../modules/expo-background-upload'); return m?.default || m; } catch { return null; } }
function _beginBg() {
  if (Platform.OS !== 'ios') return null;
  try { const m = _bgMod(); if (m?.beginBackgroundTask) { const id = m.beginBackgroundTask('chatyy-post-publish'); return (typeof id === 'number' && id >= 0) ? id : null; } } catch {}
  return null;
}
function _endBg(id) { if (id == null) return; try { _bgMod()?.endBackgroundTask?.(id); } catch {} }
function _diag(info) { try { require('./crashReporter').reportStep('post_pub', String(info || '').slice(0, 300)); } catch {} }
function _net() {
  try { const n = require('./networkInfo'); return `${n.getNetworkType?.() || '-'}/${n.getLinkClass?.() || '-'}`; } catch { return '-'; }
}

export function newPostJobId() {
  return `pp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Leitura ────────────────────────────────────────────────────────────────
function _snapshot(j) {
  if (!j) return null;
  return {
    id: j.id,
    email: j.email,
    status: j.status, // queued | preparing | uploading | publishing | done | failed
    progress: j.progress || 0,
    error: j.error || null,
    waiting: j.status === 'queued' && !!j.error,
    caption: j.meta?.caption || '',
    audience: j.meta?.audience || 'everyone',
    kind: (j.items || []).length ? 'media' : 'text',
    coverUri: (j.items && j.items[0] && (j.items[0].posterUri || j.items[0].localUri)) || null,
    count: (j.items || []).length,
    post: j.post || null,
    createdAt: j.createdAt,
  };
}
export function getProfilePostJobs(email) {
  const em = String(email || '').toLowerCase();
  const out = [];
  for (const j of _jobs.values()) {
    if (em && j.email && j.email !== em) continue;
    out.push(_snapshot(j));
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
export function subscribeProfilePostJobs(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => _subs.delete(fn);
}
/** fn(post) quando o servidor confirmou (post no formato do feed_list). */
export function onProfilePostPublished(fn) {
  if (typeof fn !== 'function') return () => {};
  _publishedSubs.add(fn);
  return () => _publishedSubs.delete(fn);
}

/**
 * Posts "otimistas" para a grade do próprio perfil (mais novo primeiro).
 * id = id do servidor quando já confirmou (a grade deduplica), senão 'pp:<job>'.
 */
export function pendingGridPosts(email) {
  const list = getProfilePostJobs(email).slice().reverse();
  return list.map((s) => {
    const j = _jobs.get(s.id);
    const items = (j && j.items) || [];
    const first = items[0] || {};
    const local = items.map((it) => it.posterUri || it.localUri || it.uri).filter(Boolean);
    return {
      id: s.post?.id ? s.post.id : `pp:${s.id}`,
      thumbnail: first.posterUri || first.localUri || first.uri || '',
      media_urls: (s.post && Array.isArray(s.post.media_urls) && s.post.media_urls.length) ? s.post.media_urls : local,
      media_type: !items.length ? 'text' : first.type === 'video' ? 'video' : 'image',
      type: !items.length ? 'text' : first.type === 'video' ? 'video' : 'image',
      kind: !items.length ? 'text' : (s.caption ? 'media_text' : 'media'),
      text: String(s.caption || '').slice(0, 1000),
      audience: s.audience,
      caption: String(s.caption || '').slice(0, items.length ? 120 : 1000),
      count: items.length,
      created_at: new Date(s.createdAt).toISOString(),
      // confirmado = post normal (abre no visualizador com as URLs do CDN); antes disso, otimista
      __pending: s.status === 'done' ? undefined : { jobId: s.id, status: s.status, progress: s.progress, error: s.error, waiting: s.waiting },
    };
  });
}

let _lastEmitAt = 0;
function _emit(force = false) {
  const now = Date.now();
  if (!force && now - _lastEmitAt < 150) return;
  _lastEmitAt = now;
  for (const fn of _subs) { try { fn(); } catch {} }
}

// ─── Persistência (nativo) ──────────────────────────────────────────────────
function _persistItem(it) {
  return {
    uri: it.uri, type: it.type, width: it.width || 0, height: it.height || 0, duration: it.duration || 0,
    fileName: it.fileName, mimeType: it.mimeType, localUri: it.localUri || null, posterUri: it.posterUri || null,
    prepared: !!it.prepared, size: it.size || 0, cdnUrl: it.cdnUrl || null, posterUrl: it.posterUrl || null,
    rustUploadId: it.rustUploadId || null,
  };
}
async function _persist() {
  if (Platform.OS === 'web') return;
  try {
    const list = [];
    for (const j of _jobs.values()) {
      if (j.status === 'done') continue;
      list.push({ id: j.id, email: j.email, createdAt: j.createdAt, status: j.status, progress: j.progress || 0, error: j.error || null, meta: j.meta, items: (j.items || []).map(_persistItem), t: j.t || {} });
    }
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {}
}
async function _loadPersisted(email) {
  if (Platform.OS === 'web' || !email) return;
  const em = String(email).toLowerCase();
  if (_loadedFor === em) return;
  _loadedFor = em;
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return;
    for (const j of list) {
      if (!j?.id || _jobs.has(j.id)) continue;
      if (j.status !== 'failed') j.status = 'queued';
      j.attempts = 0;
      j.retryAt = 0;
      _jobs.set(j.id, j);
    }
  } catch {}
}

// ─── Preparo (no aparelho) ─────────────────────────────────────────────────
function _getSize(uri) {
  return new Promise((resolve) => {
    try { require('react-native').Image.getSize(uri, (w, h) => resolve({ w, h }), () => resolve(null)); } catch { resolve(null); }
  });
}
const ASPECT_RATIO = { '1:1': 1, '4:5': 0.8 };

async function _prepareImage(job, it, idx) {
  let IM = null;
  try { IM = require('expo-image-manipulator'); } catch { IM = null; }
  if (!IM || typeof IM.manipulateAsync !== 'function' || Platform.OS === 'web') return { uri: it.uri };
  const sz = await _getSize(it.uri);
  const w = sz?.w || it.width || 0;
  const h = sz?.h || it.height || 0;
  const ratio = ASPECT_RATIO[job.meta?.aspect];
  if (ratio && w > 0 && h > 0) {
    // recorte central no formato + lado maior 2048 + JPEG 0,8 numa passada só
    let cw = w; let ch = h;
    if (w / h > ratio) { cw = Math.round(h * ratio); } else { ch = Math.round(w / ratio); }
    cw = Math.min(cw, w); ch = Math.min(ch, h);
    const actions = [{ crop: { originX: Math.max(0, Math.floor((w - cw) / 2)), originY: Math.max(0, Math.floor((h - ch) / 2)), width: cw, height: ch } }];
    const longest = Math.max(cw, ch);
    if (longest > IMAGE_MAX_DIM) actions.push({ resize: cw >= ch ? { width: IMAGE_MAX_DIM } : { height: IMAGE_MAX_DIM } });
    const out = await IM.manipulateAsync(it.uri, actions, { compress: IMAGE_QUALITY, format: IM.SaveFormat?.JPEG || 'jpeg' });
    if (out?.uri) return { uri: out.uri, width: out.width, height: out.height, mime: 'image/jpeg', ext: 'jpg' };
    return { uri: it.uri };
  }
  // Sem recorte: MESMA utilidade do chat (fit-in-box, nunca amplia, tira EXIF/HEIC).
  try {
    const { compressImage } = require('./mediaSendQueue');
    const r = await compressImage(it.uri, { maxDim: IMAGE_MAX_DIM, quality: IMAGE_QUALITY }, it.fileName || `photo_${idx}`);
    if (r?.uri) return { uri: r.uri, width: r.width, height: r.height, mime: 'image/jpeg', ext: 'jpg', size: r.size };
  } catch {}
  return { uri: it.uri };
}

async function _prepareVideo(job, it) {
  let vsp = null;
  try { vsp = require('./videoSendPipeline'); } catch { vsp = null; }
  let uri = it.uri;
  let width = it.width || 0; let height = it.height || 0;
  try {
    const FS = _FS();
    let size = 0;
    try { const info = FS ? await FS.getInfoAsync(uri) : null; size = info?.size || 0; } catch {}
    if (vsp && size > VIDEO_COMPRESS_MIN_BYTES) {
      const label = vsp.resolveVideoLabel?.(null) || '720p';
      const prof = vsp.getQualityProfile?.(label);
      if (prof) {
        const r = await vsp.prepareCompressed(uri, prof, null, null);
        if (r && !r.skipped && r.uri && r.uri !== uri) { uri = r.uri; width = r.width || width; height = r.height || height; }
      }
    }
  } catch {}
  let poster = null;
  try { poster = vsp ? await vsp.preparePoster(uri, it.duration ? Math.round(it.duration) : null) : null; } catch { poster = null; }
  if (!poster?.posterUri) {
    try {
      const { getThumbnailAsync } = require('expo-video-thumbnails');
      const r = await getThumbnailAsync(uri, { time: 500, quality: 0.7 });
      if (r?.uri) poster = { posterUri: r.uri };
    } catch {}
  }
  return { uri, width, height, mime: 'video/mp4', ext: 'mp4', posterUri: poster?.posterUri || null };
}

async function _toDurable(job, idx, uri, ext, suffix = '') {
  const FS = _FS();
  if (!FS || !FS.documentDirectory || !uri) return uri;
  const dir = FS.documentDirectory + OUTBOX_DIR;
  if (String(uri).startsWith(dir)) return uri;
  try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
  const dest = `${dir}${job.id}_${idx}${suffix}.${ext}`;
  try {
    // saída do nosso compressor (cache) → mover (grátis); arquivo do seletor → copiar
    if (/ImageManipulator|ExpoImageManipulator|VideoThumbnails|cache/i.test(String(uri)) && !/^ph:|^content:/i.test(String(uri))) {
      try { await FS.moveAsync({ from: uri, to: dest }); return dest; } catch {}
    }
    await FS.copyAsync({ from: uri, to: dest });
    return dest;
  } catch { return uri; }
}

async function _prepareItem(job, it, idx) {
  if (it.prepared && it.localUri) return;
  const t0 = Date.now();
  let r = null;
  try { r = it.type === 'video' ? await _prepareVideo(job, it) : await _prepareImage(job, it, idx); } catch { r = { uri: it.uri }; }
  const ext = r?.ext || (it.type === 'video' ? 'mp4' : 'jpg');
  it.localUri = await _toDurable(job, idx, r?.uri || it.uri, ext);
  if (r?.posterUri) it.posterUri = await _toDurable(job, idx, r.posterUri, 'jpg', '_poster');
  if (r?.width) it.width = r.width;
  if (r?.height) it.height = r.height;
  if (r?.mime) it.mimeType = r.mime;
  const base = String(it.fileName || (it.type === 'video' ? 'video' : 'photo')).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60) || 'media';
  it.fileName = `${base}.${ext}`;
  try { const FS = _FS(); const info = FS ? await FS.getInfoAsync(it.localUri) : null; if (info?.size) it.size = info.size; } catch {}
  it.prepared = true;
  job.t.prep = (job.t.prep || 0) + (Date.now() - t0);
}

// ─── Enfileirar / controle ─────────────────────────────────────────────────
/**
 * enqueueProfilePost({ email, items: [{uri,type,width,height,duration,fileName,mimeType}],
 *   caption, audience, aspect }) → snapshot (na hora; o resto roda em 2º plano).
 */
export function enqueueProfilePost(input) {
  const id = input?.id || newPostJobId();
  const items = (input?.items || []).slice(0, 10).map((it, i) => ({
    uri: it.uri,
    type: it.type === 'video' ? 'video' : 'image',
    width: it.width || 0,
    height: it.height || 0,
    duration: it.duration || 0,
    fileName: it.fileName || `media_${i}.${it.type === 'video' ? 'mp4' : 'jpg'}`,
    mimeType: it.mimeType || (it.type === 'video' ? 'video/mp4' : 'image/jpeg'),
    file: (Platform.OS === 'web' && typeof Blob !== 'undefined' && it.file instanceof Blob) ? it.file : null,
    localUri: null, posterUri: null, prepared: false, size: 0, cdnUrl: null, posterUrl: null, rustUploadId: null,
  }));
  const caption0 = String(input?.caption || '').trim();
  if (!items.length && !caption0) throw new Error('no_items');
  const job = {
    id,
    email: String(input?.email || '').toLowerCase(),
    createdAt: Date.now(),
    status: 'queued',
    progress: 0,
    attempts: 0,
    error: null,
    meta: {
      caption: String(input?.caption || '').slice(0, 2200),
      audience: _aud(input?.audience),
      aspect: input?.aspect || '1:1',
      allowComments: input?.allowComments !== false,
      location: input?.location && input.location.name ? { name: String(input.location.name).slice(0, 120), latitude: input.location.latitude ?? null, longitude: input.location.longitude ?? null } : null,
    },
    items,
    t: { tap: Date.now() },
  };
  _jobs.set(id, job);
  _emit(true);
  _persist();
  _ensureAppState();
  // depois do 1º quadro (folha fechando) — não disputa o JS com a animação
  setTimeout(() => _kick(), 60);
  return _snapshot(job);
}

// público: contrato public|contacts|private; "everyone" = public (servidor antigo só conhece everyone/contacts)
function _aud(a) {
  const v = String(a || '').toLowerCase();
  if (v === 'contacts' || v === 'followers' || v === 'close_friends') return 'contacts';
  if (v === 'private' || v === 'only_me' || v === 'me') return 'private';
  return 'everyone';
}

export function retryProfilePost(id) {
  const j = _jobs.get(id);
  if (!j || j.status === 'done') return;
  j.status = 'queued';
  j.error = null;
  j.attempts = 0;
  j.retryAt = 0;
  _emit(true);
  _persist();
  _kick();
}

export async function cancelProfilePost(id) {
  const j = _jobs.get(id);
  if (!j) return;
  j.cancelled = true;
  try { j.ctrl?.abort(); } catch {}
  _jobs.delete(id);
  _emit(true);
  await _persist();
  await _cleanupFiles(j);
}

export function dismissProfilePostJob(id) {
  const j = _jobs.get(id);
  if (j && j.status === 'done') { _jobs.delete(id); _emit(true); }
}

/** Carrega jobs salvos desta conta (nativo) e retoma os pendentes. */
export async function resumeProfilePosts(email) {
  await _loadPersisted(email);
  _ensureAppState();
  _emit(true);
  _kick();
}

function _ensureAppState() {
  if (_appStateSub || Platform.OS === 'web') return;
  try {
    _appStateSub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return;
      // voltou ao app: quem estava esperando a rede tenta já
      for (const j of _jobs.values()) { if (j.status === 'queued' && j.retryAt) { j.retryAt = 0; } }
      _kick();
    });
  } catch {}
}

async function _cleanupFiles(job) {
  const FS = _FS();
  if (!FS || !FS.documentDirectory) return;
  const dir = FS.documentDirectory + OUTBOX_DIR;
  for (const it of job.items || []) {
    for (const u of [it.localUri, it.posterUri]) {
      if (u && String(u).startsWith(dir)) { try { await FS.deleteAsync(u, { idempotent: true }); } catch {} }
    }
  }
}

// ─── Worker ─────────────────────────────────────────────────────────────────
function _kick(delayMs = 0) {
  if (_wakeTimer) { clearTimeout(_wakeTimer); _wakeTimer = null; }
  if (delayMs > 0) { _wakeTimer = setTimeout(() => { _wakeTimer = null; _kick(); }, delayMs); return; }
  if (_running) return;
  const now = Date.now();
  const next = [..._jobs.values()]
    .filter((j) => j.status === 'queued' && (!j.retryAt || j.retryAt <= now))
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) return;
  _running = next.id;
  _run(next).catch(() => {}).finally(() => {
    _running = null;
    if ([..._jobs.values()].some((j) => j.status === 'queued' && !j.retryAt)) _kick();
  });
}

function _hardError(msg) {
  return /invalid|required|max \d+|not your|dangerous|too large|>200mb|413|415|403|suspen|blocked|bloque/i.test(String(msg || ''));
}

function _recalc(job) {
  const n = job.items.length || 1;
  let sum = 0;
  for (const it of job.items) {
    if (it.cdnUrl) { sum += 1; continue; }
    sum += (it.prepared ? 0.15 : 0) + 0.85 * Math.max(0, Math.min(1, it._up || 0));
  }
  job.progress = Math.max(job.progress || 0, Math.min(0.92, (sum / n) * 0.92));
}

async function _uploadItem(job, it, api) {
  const file = Platform.OS === 'web'
    ? (it.file ? { _raw: it.file, uri: it.uri, name: it.fileName, type: it.mimeType, size: it.file.size } : { uri: it.uri, name: it.fileName, type: it.mimeType })
    : { uri: it.localUri || it.uri, name: it.fileName, type: it.mimeType, size: it.size || 0 };
  const onProgress = (f) => { it._up = Math.max(0, Math.min(1, Number(f) || 0)); _recalc(job); _emit(); };
  let r = null;
  try {
    if (it.type === 'video') {
      const resume = Platform.OS === 'web' ? null : { uploadId: it.rustUploadId || null, onUploadId: (uid) => { it.rustUploadId = uid; _persist(); } };
      r = await api.rustChunkedUpload(file, job.email, 'feed', onProgress, job.ctrl?.signal || null, resume);
    } else {
      r = await api.rustUpload(file, job.email, 'feed', job.ctrl?.signal || null, onProgress);
    }
  } catch (e) { r = { success: false, error: e?.message || 'upload_error' }; }
  const url = r?.cdn_url || r?.data?.cdn_url || null;
  if (!r || !r.success || !url) {
    const err = (r && (r.error || r.message)) || 'upload_failed';
    throw Object.assign(new Error(String(err)), { unavailable: r?.error === 'unavailable', hard: /Dangerous|too large|413|415/i.test(String(err)) });
  }
  it.cdnUrl = url;
  it._up = 1;
  // capa do vídeo (pequena) — falhar aqui não impede o post (o servidor gera depois)
  if (it.type === 'video' && it.posterUri && !it.posterUrl && Platform.OS !== 'web') {
    try {
      const pr = await api.rustUpload({ uri: it.posterUri, name: it.fileName.replace(/\.\w+$/, '') + '_poster.jpg', type: 'image/jpeg' }, job.email, 'feed', job.ctrl?.signal || null, null);
      const pu = pr?.cdn_url || pr?.data?.cdn_url || null;
      if (pr?.success && pu) it.posterUrl = pu;
    } catch {}
  }
  _recalc(job);
  _emit(true);
  _persist();
}

async function _run(job) {
  const api = _api();
  if (!api) return;
  job.retryAt = 0;
  job.error = null;
  job.t = job.t || {};
  job.ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const bg = _beginBg();
  const tRun = Date.now();
  try {
    // [mural 2026-10-20] só texto: nada a preparar/subir
    if (!job.items.length) {
      await _publish(job, false);
      _diag(`ok id=${job.id} n=0 text=1 conf=${job.t.conf || 0} vis=${Date.now() - (job.t.tap || tRun)} att=${job.attempts || 0} net=${_net()}`);
      return;
    }
    // 1+2) preparo e upload em paralelo (3 itens de cada vez, ordem preservada)
    job.status = job.items.every((it) => it.prepared) ? 'uploading' : 'preparing';
    _emit(true);
    let cursor = 0;
    let fallbackMultipart = false;
    const worker = async () => {
      while (!job.cancelled && !fallbackMultipart) {
        const idx = cursor++;
        if (idx >= job.items.length) return;
        const it = job.items[idx];
        if (it.cdnUrl) continue;
        await _prepareItem(job, it, idx);
        _recalc(job);
        if (job.status === 'preparing') job.status = 'uploading';
        _emit(true);
        _persist();
        const tu = Date.now();
        try {
          await _uploadItem(job, it, api);
        } catch (e) {
          if (e?.unavailable) { fallbackMultipart = true; return; }
          throw e;
        } finally {
          job.t.up = (job.t.up || 0) + (Date.now() - tu);
        }
      }
    };
    const n = Math.max(1, Math.min(UPLOAD_CONCURRENCY, job.items.length));
    // allSettled: um item que falha não deixa os outros subindo "soltos" enquanto o retry começa
    let firstErr = null;
    const stop = () => { cursor = job.items.length; };
    const results = await Promise.allSettled(Array.from({ length: n }, () => worker().catch((e) => { if (!firstErr) firstErr = e; stop(); throw e; })));
    if (firstErr || results.some((r) => r.status === 'rejected')) throw (firstErr || new Error('upload_failed'));
    if (job.cancelled) return;
    if (fallbackMultipart) {
      for (let i = 0; i < job.items.length; i++) await _prepareItem(job, job.items[i], i);
      await _publish(job, true);
    } else {
      await _publish(job, false);
    }
    const tt = job.t;
    const bytes = job.items.reduce((a, it) => a + (it.size || 0), 0);
    _diag(`ok id=${job.id} n=${job.items.length} kb=${Math.round(bytes / 1024)} prep=${tt.prep || 0} up=${tt.up || 0} conf=${tt.conf || 0} vis=${Date.now() - (tt.tap || tRun)} run=${Date.now() - tRun} att=${job.attempts || 0} base=${(api.getRustUploadBase?.() || '').replace(/^https?:\/\//, '').split('.')[0] || '-'} mp=${fallbackMultipart ? 1 : 0} net=${_net()}`);
  } catch (e) {
    if (job.cancelled) return;
    job.attempts = (job.attempts || 0) + 1;
    const msg = e?.message || 'error';
    const hard = e?.hard || _hardError(msg);
    _diag(`fail id=${job.id} att=${job.attempts} hard=${hard ? 1 : 0} err=${String(msg).slice(0, 60)} up=${job.t?.up || 0} net=${_net()}`);
    if (hard || job.attempts >= MAX_ATTEMPTS) {
      job.status = 'failed';
      job.error = msg;
      _emit(true);
      _persist();
      _notify(job, false);
    } else {
      job.status = 'queued';
      job.error = msg;
      const delay = Math.min(60_000, 2000 * Math.pow(2, job.attempts - 1));
      job.retryAt = Date.now() + delay;
      _emit(true);
      _persist();
      setTimeout(() => { if (_jobs.get(job.id) === job && job.status === 'queued') { job.retryAt = 0; _kick(); } }, delay);
    }
  } finally {
    job.ctrl = null;
    _endBg(bg);
  }
}

async function _publish(job, multipart) {
  const api = _api();
  job.status = 'publishing';
  job.progress = Math.max(job.progress, 0.92);
  _emit(true);
  const m = job.meta || {};
  const first = job.items[0] || {};
  const fd = new FormData();
  fd.append('client_post_id', job.id);
  fd.append('caption', String(m.caption || '').trim());
  fd.append('text', String(m.caption || '').trim());
  if (job.items.length) {
    fd.append('media_type', first.type === 'video' ? 'video' : 'image');
    fd.append('post_aspect', m.aspect || '1:1');
  }
  fd.append('audience', m.audience || 'everyone');
  if (m.allowComments === false) fd.append('allow_comments', '0');
  if (m.location && m.location.name) {
    fd.append('location', m.location.name);
    fd.append('location_name', m.location.name);
    if (m.location.latitude != null && m.location.longitude != null) {
      fd.append('location_lat', String(m.location.latitude));
      fd.append('location_lon', String(m.location.longitude));
    }
  }
  if (multipart) {
    for (const it of job.items) {
      if (Platform.OS === 'web' && it.file) fd.append('media[]', it.file, it.fileName);
      else fd.append('media[]', { uri: it.localUri || it.uri, name: it.fileName, type: it.mimeType });
    }
  } else {
    if (job.items.length) {
      fd.append('media_urls', JSON.stringify(job.items.map((it) => it.cdnUrl)));
      try {
        fd.append('media_meta', JSON.stringify(job.items.map((it) => ({ w: it.width || null, h: it.height || null, ...(it.posterUrl ? { thumb: it.posterUrl } : {}) }))));
      } catch {}
      if (first.type === 'video' && first.posterUrl) fd.append('thumb_url', first.posterUrl);
    }
  }
  const tc = Date.now();
  const r = await api.feedCreatePost(fd);
  job.t.conf = Date.now() - tc;
  if (job.cancelled) return;
  if (!r || !r.success) {
    const msg = (r && (r.error || r.message)) || 'publish_failed';
    throw Object.assign(new Error(String(msg)), { hard: _hardError(msg) && !/network|abort|timeout|fetch|conex/i.test(String(msg)) });
  }
  const post = r.data?.post || r.data || {};
  const full = {
    likes: 0, likes_count: 0, like_count: 0,
    comments: 0, comments_count: 0,
    views: 0, view_count: 0,
    user_liked: false, user_bookmarked: false,
    tagged_users: [],
    created_at: new Date().toISOString(),
    ...post,
  };
  job.status = 'done';
  job.progress = 1;
  job.post = full;
  job.error = null;
  _emit(true);
  await _persist();
  _afterPublished(full);
  for (const fn of _publishedSubs) { try { fn(full); } catch {} }
  _notify(job, true);
  // o post otimista fica até o perfil recarregar (a grade deduplica pelo id) e some
  setTimeout(() => {
    if (_jobs.get(job.id) === job) { _jobs.delete(job.id); _emit(true); }
    _cleanupFiles(job).catch(() => {});
  }, 8000);
}

/** Caches do perfil/feed na hora (mesmo efeito para todos os compositores). */
function _afterPublished(post) {
  try { require('./muralStore').primePost(post); } catch {}
  try { require('./api').swrInvalidate?.('profile_get'); } catch {}
  try { require('../components/Profile').markProfileCacheStale?.(null); } catch {}
  try {
    const { getCached, setCache } = require('./cache');
    Promise.resolve(getCached('feed_posts')).then((cached) => {
      const list = Array.isArray(cached) ? cached.filter((p) => p?.id !== post.id) : [];
      return setCache('feed_posts', [post, ...list].slice(0, 200), 7776000000);
    }).catch(() => {});
  } catch {}
  // POSTS_CHANGED_EVENT já sai do api.feedCreatePost (vale p/ todos os compositores)
}

function _notify(job, ok) {
  if (Platform.OS === 'web') return;
  try {
    if (AppState.currentState === 'active') {
      if (ok) { try { require('./haptics').hapticEvent?.('success'); } catch {} }
      return;
    }
    let pc = null;
    try { pc = require('./profilePostComposer').pcT; } catch {}
    const tr = (k, fb) => { try { return pc ? pc(k) : fb; } catch { return fb; } };
    const N = require('expo-notifications');
    N.scheduleNotificationAsync({
      content: {
        title: ok ? tr('published', 'Publicado no seu perfil') : tr('failed', 'Não foi possível publicar'),
        body: ok ? '' : tr('retry', 'Tentar de novo'),
        data: { type: 'profile_post_publish', post_id: job.post?.id ? String(job.post.id) : '', route: job.email ? `/u/${encodeURIComponent(job.email)}` : '/chat?tab=feed' },
      },
      trigger: null,
    }).catch(() => {});
  } catch {}
}

export default {
  enqueueProfilePost,
  retryProfilePost,
  cancelProfilePost,
  dismissProfilePostJob,
  resumeProfilePosts,
  getProfilePostJobs,
  subscribeProfilePostJobs,
  onProfilePostPublished,
  pendingGridPosts,
  isProfilePostQueueEnabled,
  newPostJobId,
};
