/**
 * Reel publish queue — [2026-10-08 reels-publish]
 *
 * "Publicar" in /reels-compose hands the reel to this module and the screen
 * closes immediately; the upload keeps going in the background:
 *
 *   • every clip goes up through the Rust chunked uploader (context 'feed'),
 *     resumable on native: the Rust session id is persisted per clip, so a
 *     retry after a network drop / app kill only sends the missing chunks;
 *   • then ONE feed_create_post call (is_reel=1, media_url [+ clip_urls],
 *     trim/cover/audience/allow_comments) — the server joins clips, cuts to the
 *     chosen range (≤ 90 s), renders the cover frame and inserts the post;
 *   • idempotent: the job id rides as client_post_id, so a retry after a lost
 *     response returns the SAME post instead of a duplicate reel;
 *   • durable on native: jobs live in AsyncStorage (namespaced by account) and
 *     their clips are copied into documentDirectory/reels-outbox/, so a cold
 *     start resumes them (resumeReelPublishes). Web keeps jobs in memory only
 *     (blob: URLs die with the tab) — they still survive leaving the screen;
 *   • progress + lifecycle events for the inline banner in the Reels tab
 *     (components/ReelPublishProgress.js) and for ReelsViewer, which prepends
 *     the freshly published reel to "Seguindo"/"Pra você".
 */
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORE_KEY = 'reel_publish_jobs_v1';
const OUTBOX_DIR = 'reels-outbox/';
const MAX_ATTEMPTS = 8;
export const REEL_MAX_MS = 90_000;

const _jobs = new Map(); // id -> job
const _subs = new Set();
const _publishedSubs = new Set();
let _running = null; // id currently running
let _wakeTimer = null;
let _loadedFor = null; // email whose persisted jobs were loaded

function _api() { try { return require('./api'); } catch { return null; } }
function _FS() { if (Platform.OS === 'web') return null; try { return require('expo-file-system/legacy'); } catch { return null; } }
function _bgMod() { try { const m = require('../modules/expo-background-upload'); return m?.default || m; } catch { return null; } }
function _beginBg() {
  if (Platform.OS !== 'ios') return null;
  try { const m = _bgMod(); if (m?.beginBackgroundTask) { const id = m.beginBackgroundTask('chatyy-reel-publish'); return (typeof id === 'number' && id >= 0) ? id : null; } } catch {}
  return null;
}
function _endBg(id) { if (id == null) return; try { _bgMod()?.endBackgroundTask?.(id); } catch {} }

export function newReelJobId() {
  return `reel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Public read API ─────────────────────────────────────────────────────────
function _snapshot(job) {
  if (!job) return null;
  return {
    id: job.id,
    email: job.email,
    status: job.status, // queued | uploading | publishing | done | failed
    progress: job.progress || 0,
    error: job.error || null,
    caption: job.meta?.caption || '',
    coverUri: job.coverUri || null,
    post: job.post || null,
    createdAt: job.createdAt,
  };
}
export function getReelJobs(email) {
  const out = [];
  for (const j of _jobs.values()) {
    if (email && j.email && String(j.email).toLowerCase() !== String(email).toLowerCase()) continue;
    out.push(_snapshot(j));
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}
export function subscribeReelJobs(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => _subs.delete(fn);
}
/** fn(post) after the server confirmed the reel (post shaped like feed_list rows). */
export function onReelPublished(fn) {
  if (typeof fn !== 'function') return () => {};
  _publishedSubs.add(fn);
  return () => _publishedSubs.delete(fn);
}

let _lastEmitAt = 0;
function _emit(force = false) {
  const now = Date.now();
  if (!force && now - _lastEmitAt < 150) return; // progress throttle
  _lastEmitAt = now;
  for (const fn of _subs) { try { fn(); } catch {} }
}

// ─── Persistence (native only) ───────────────────────────────────────────────
function _persistable(job) {
  // Web clips are blob/File-backed → nothing durable to keep.
  return Platform.OS !== 'web' && job.status !== 'done';
}
async function _persist() {
  if (Platform.OS === 'web') return;
  try {
    const list = [];
    for (const j of _jobs.values()) {
      if (!_persistable(j)) continue;
      list.push({ ...j, clips: (j.clips || []).map(c => ({ uri: c.uri, name: c.name, type: c.type, size: c.size, durationMs: c.durationMs, cdnUrl: c.cdnUrl || null, rustUploadId: c.rustUploadId || null })) });
    }
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {}
}
async function _loadPersisted(email) {
  if (Platform.OS === 'web' || !email) return;
  if (_loadedFor === String(email).toLowerCase()) return;
  _loadedFor = String(email).toLowerCase();
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return;
    for (const j of list) {
      if (!j?.id || _jobs.has(j.id)) continue;
      if (j.status === 'uploading' || j.status === 'publishing') j.status = 'queued';
      j.attempts = 0;
      _jobs.set(j.id, j);
    }
  } catch {}
}

// ─── Durable copies ──────────────────────────────────────────────────────────
function _ext(name, uri, type) {
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(String(name || '')) || /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(String(uri || ''));
  if (m) return m[1].toLowerCase();
  if (/quicktime/i.test(type || '')) return 'mov';
  if (/webm/i.test(type || '')) return 'webm';
  return 'mp4';
}
async function _makeDurable(job) {
  const FS = _FS();
  if (!FS || !FS.documentDirectory) return;
  const dir = FS.documentDirectory + OUTBOX_DIR;
  try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
  for (let i = 0; i < job.clips.length; i++) {
    const c = job.clips[i];
    if (!c?.uri || String(c.uri).startsWith(dir)) continue;
    const ext = _ext(c.name, c.uri, c.type);
    const dest = `${dir}${job.id}_${i}.${ext}`;
    try {
      await FS.copyAsync({ from: c.uri, to: dest });
      c.uri = dest;
      c.name = c.name || `${job.id}_${i}.${ext}`;
      try { const info = await FS.getInfoAsync(dest); if (info?.size) c.size = info.size; } catch {}
    } catch { /* keep original uri — still works while it exists */ }
  }
}
async function _cleanupFiles(job) {
  const FS = _FS();
  if (!FS || !FS.documentDirectory) return;
  const dir = FS.documentDirectory + OUTBOX_DIR;
  for (const c of job.clips || []) {
    if (c?.uri && String(c.uri).startsWith(dir)) { try { await FS.deleteAsync(c.uri, { idempotent: true }); } catch {} }
  }
}

// ─── Enqueue / control ───────────────────────────────────────────────────────
/**
 * enqueueReelPublish({
 *   email, clips: [{ uri, name?, type?, size?, durationMs?, file? (web File) }],
 *   meta: { caption, audience, allowComments, coverMs, trimStartMs, trimEndMs,
 *           durationMs, sound: {id,label}|null, tagged: [emails] },
 *   draftId?, coverUri?
 * }) → job id
 */
export async function enqueueReelPublish(input) {
  const id = input?.id || newReelJobId();
  const job = {
    id,
    email: String(input?.email || '').toLowerCase(),
    createdAt: Date.now(),
    status: 'queued',
    progress: 0,
    attempts: 0,
    error: null,
    draftId: input?.draftId || null,
    coverUri: input?.coverUri || null,
    meta: { ...(input?.meta || {}) },
    clips: (input?.clips || []).map((c, i) => ({
      uri: c.uri,
      name: c.name || `reel_${i}.${_ext(c.name, c.uri, c.type)}`,
      type: c.type || 'video/mp4',
      size: c.size || 0,
      durationMs: c.durationMs || 0,
      file: (typeof Blob !== 'undefined' && c.file instanceof Blob) ? c.file : null, // web only (not persisted)
      cdnUrl: null,
      rustUploadId: null,
    })),
  };
  if (!job.clips.length) throw new Error('no_clips');
  _jobs.set(id, job);
  _emit(true);
  if (Platform.OS !== 'web') {
    await _makeDurable(job);
    await _persist();
  }
  _kick();
  return id;
}

export function retryReelPublish(id) {
  const j = _jobs.get(id);
  if (!j || j.status === 'done') return;
  j.status = 'queued';
  j.error = null;
  j.attempts = 0;
  _emit(true);
  _persist();
  _kick();
}

export async function cancelReelPublish(id) {
  const j = _jobs.get(id);
  if (!j) return;
  j.cancelled = true;
  try { j.ctrl?.abort(); } catch {}
  _jobs.delete(id);
  _emit(true);
  await _persist();
  // Keep files when the job came from a draft (draft owns its own copies).
  await _cleanupFiles(j);
}

export function dismissReelJob(id) {
  const j = _jobs.get(id);
  if (!j) return;
  if (j.status === 'done') { _jobs.delete(id); _emit(true); }
}

/** Load persisted jobs for this account (native) and restart pending ones. */
export async function resumeReelPublishes(email) {
  await _loadPersisted(email);
  _emit(true);
  _kick();
}

// ─── Worker ──────────────────────────────────────────────────────────────────
function _kick(delayMs = 0) {
  if (_wakeTimer) { clearTimeout(_wakeTimer); _wakeTimer = null; }
  if (delayMs > 0) { _wakeTimer = setTimeout(() => { _wakeTimer = null; _kick(); }, delayMs); return; }
  if (_running) return;
  const next = [..._jobs.values()].filter(j => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
  if (!next) return;
  _running = next.id;
  _run(next).catch(() => {}).finally(() => {
    _running = null;
    // Pending retries are scheduled by _run via _kick(delay).
    if ([..._jobs.values()].some(j => j.status === 'queued' && !j.retryAt)) _kick();
  });
}

function _hardError(msg) {
  return /invalid|required|max \d+|not your|dangerous|too large|>200mb|clip|413|415|403/i.test(String(msg || ''));
}

async function _run(job) {
  const api = _api();
  if (!api) return;
  job.retryAt = 0;
  job.status = 'uploading';
  job.error = null;
  job.ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  _emit(true);
  const bg = _beginBg();
  try {
    // 1) Upload clips (bytes-weighted progress, 0 → 90 %).
    const sizes = job.clips.map(c => Math.max(1, c.size || c.file?.size || 1));
    const total = sizes.reduce((a, b) => a + b, 0);
    let doneBytes = 0;
    for (let i = 0; i < job.clips.length; i++) {
      const c = job.clips[i];
      if (job.cancelled) return;
      if (c.cdnUrl) { doneBytes += sizes[i]; continue; }
      const file = Platform.OS === 'web'
        ? ((typeof Blob !== 'undefined' && c.file instanceof Blob)
          ? { _raw: c.file, uri: c.uri, name: c.name, type: c.type || c.file.type, size: c.file.size }
          : { uri: c.uri, name: c.name, type: c.type })
        : { uri: c.uri, name: c.name, type: c.type, size: c.size || 0 };
      const onProgress = (f) => {
        const frac = Math.max(0, Math.min(1, Number(f) || 0));
        job.progress = Math.min(0.9, ((doneBytes + frac * sizes[i]) / total) * 0.9);
        _emit();
      };
      const resume = Platform.OS === 'web' ? null : {
        uploadId: c.rustUploadId || null,
        onUploadId: (uid) => { c.rustUploadId = uid; _persist(); },
      };
      let r = null;
      try { r = await api.rustChunkedUpload(file, job.email, 'feed', onProgress, job.ctrl?.signal || null, resume); } catch (e) { r = { success: false, error: e?.message || 'upload_error' }; }
      if (job.cancelled) return;
      const url = r?.cdn_url || r?.data?.cdn_url || null;
      if (!r || !r.success || !url) {
        const err = (r && (r.error || r.message)) || 'upload_failed';
        if (r?.error === 'unavailable' && job.clips.length === 1) {
          // Rust down → single multipart POST straight to feed_create_post.
          return await _publish(job, null, file);
        }
        throw Object.assign(new Error(String(err)), { hard: /Dangerous|too large|413|415/i.test(String(err)) });
      }
      c.cdnUrl = url;
      doneBytes += sizes[i];
      job.progress = Math.min(0.9, (doneBytes / total) * 0.9);
      _emit(true);
      _persist();
    }
    // 2) Create the post (server joins/cuts/covers).
    await _publish(job, job.clips.map(c => c.cdnUrl), null);
  } catch (e) {
    if (job.cancelled) return;
    job.attempts = (job.attempts || 0) + 1;
    const msg = e?.message || 'error';
    if (e?.hard || _hardError(msg) || job.attempts >= MAX_ATTEMPTS) {
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

async function _publish(job, urls, rawFile) {
  const api = _api();
  job.status = 'publishing';
  job.progress = Math.max(job.progress, 0.9);
  _emit(true);
  const m = job.meta || {};
  const fd = new FormData();
  fd.append('client_post_id', job.id);
  fd.append('media_type', 'video');
  fd.append('is_reel', '1');
  fd.append('caption', String(m.caption || '').slice(0, 2200));
  if (m.audience && m.audience !== 'everyone') fd.append('audience', m.audience);
  fd.append('allow_comments', m.allowComments === false ? '0' : '1');
  if (m.coverMs != null) fd.append('cover_ms', String(Math.max(0, Math.round(m.coverMs))));
  if (m.trimStartMs > 0) fd.append('trim_start_ms', String(Math.round(m.trimStartMs)));
  if (m.trimEndMs > 0) fd.append('trim_end_ms', String(Math.round(m.trimEndMs)));
  if (m.durationMs > 0) fd.append('duration_ms', String(Math.round(m.durationMs)));
  if (m.sound?.id && m.sound.id !== 'placeholder') {
    fd.append('sound_id', String(m.sound.id));
    if (m.sound.label) fd.append('sound_label', String(m.sound.label));
  }
  if (Array.isArray(m.tagged) && m.tagged.length) fd.append('tagged', JSON.stringify(m.tagged.slice(0, 30)));
  if (urls && urls.length) {
    fd.append('media_url', urls[0]);
    if (urls.length > 1) fd.append('clip_urls', JSON.stringify(urls));
  } else if (rawFile) {
    if (Platform.OS === 'web') fd.append('media[]', rawFile._raw || rawFile.file, rawFile.name || 'reel.mp4');
    else fd.append('media[]', { uri: rawFile.uri, name: rawFile.name || 'reel.mp4', type: rawFile.type || 'video/mp4' });
  }
  const r = await api.feedCreatePost(fd);
  if (job.cancelled) return;
  if (!r || !r.success) {
    const msg = (r && (r.error || r.message)) || 'publish_failed';
    throw Object.assign(new Error(String(msg)), { hard: _hardError(msg) && !/network|abort|timeout|fetch/i.test(String(msg)) });
  }
  const post = r.data?.post || r.data || {};
  const now = new Date();
  const full = {
    media_type: 'video',
    likes: 0, likes_count: 0, like_count: 0,
    comments: 0, comments_count: 0,
    views: 0, view_count: 0,
    user_liked: false, user_bookmarked: false,
    tagged_users: [],
    created_at: now.toISOString(),
    ...post,
    is_reel: true,
  };
  job.status = 'done';
  job.progress = 1;
  job.post = full;
  job.error = null;
  _emit(true);
  await _persist(); // drops it from storage (done jobs aren't persisted)
  await _cleanupFiles(job);
  if (job.draftId) {
    try { const d = require('./reelDrafts'); await d.deleteReelDraft(job.draftId, { keepFiles: false }); } catch {}
  }
  for (const fn of _publishedSubs) { try { fn(full); } catch {} }
  _notify(job, true);
  // Banner shows "Publicado" for a few seconds, then the job disappears.
  setTimeout(() => { if (_jobs.get(job.id) === job) { _jobs.delete(job.id); _emit(true); } }, 6000);
}

// Local notification only when the user left the app (inline banner otherwise).
function _notify(job, ok) {
  if (Platform.OS === 'web') return;
  try {
    if (AppState.currentState === 'active') return;
    const N = require('expo-notifications');
    const L = (() => { try { return require('../i18n'); } catch { return null; } })();
    const lang = (() => { try { return require('./api')?.getCurrentLanguage?.() || 'pt-BR'; } catch { return 'pt-BR'; } })();
    const tr = (k, fb) => { try { const v = L?.translations?.[lang]?.[k] ?? L?.translations?.['pt-BR']?.[k]; return v || fb; } catch { return fb; } };
    N.scheduleNotificationAsync({
      content: {
        title: ok ? tr('reels.publish.doneTitle', 'Reel publicado') : tr('reels.publish.failedTitle', 'Não foi possível publicar o reel'),
        body: ok ? tr('reels.publish.doneBody', 'Seu reel já está no ar.') : tr('reels.publish.failedBody', 'Abra o Chatyy para tentar de novo.'),
        data: { type: 'reel_publish', post_id: job.post?.id ? String(job.post.id) : '', route: '/chat?tab=feed' },
      },
      trigger: null,
    }).catch(() => {});
  } catch {}
}

export default {
  enqueueReelPublish,
  retryReelPublish,
  cancelReelPublish,
  dismissReelJob,
  resumeReelPublishes,
  getReelJobs,
  subscribeReelJobs,
  onReelPublished,
  newReelJobId,
  REEL_MAX_MS,
};
