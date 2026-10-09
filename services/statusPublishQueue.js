/**
 * Status publish queue — [2026-10-09 status-composer]
 *
 * "Compartilhar" no compositor de status entrega o status para esta fila e a
 * tela fecha NA HORA; o envio continua em segundo plano:
 *
 *   • mídia sobe pelo uploader Rust com progresso (api.statusUpload), vídeo
 *     longo é fatiado em trechos ≤30s (WhatsApp) antes;
 *   • depois 1 status_create por trecho (privacidade/legenda/menções no 1º);
 *   • durável no nativo: jobs em AsyncStorage (por conta) e o arquivo copiado
 *     para documentDirectory/status-outbox/ → app fechado no meio retoma no
 *     próximo boot (resumeStatusPublishes). Web guarda em memória (blob: morre
 *     com a aba) mas sobrevive a sair da tela;
 *   • URL já enviada fica salva no job: retry após falha no status_create NÃO
 *     reenvia o arquivo;
 *   • progresso agregado (getAggregateProgress / subscribeStatusJobs) alimenta
 *     o anel do "Seu status" na faixa de stories.
 */
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORE_KEY = 'status_publish_jobs_v1';
const OUTBOX_DIR = 'status-outbox/';
const MAX_ATTEMPTS = 6;

const _jobs = new Map();
const _subs = new Set();
const _doneSubs = new Set();
let _running = false;
let _wakeTimer = null;
let _loaded = false;
let _currentEmail = ''; // conta ativa (ver setStatusQueueAccount)

function _api() { try { return require('./api'); } catch { return null; } }
function _FS() { if (Platform.OS === 'web') return null; try { return require('expo-file-system/legacy'); } catch { return null; } }
function _bgMod() { try { const m = require('../modules/expo-background-upload'); return m?.default || m; } catch { return null; } }
function _beginBg() {
  if (Platform.OS !== 'ios') return null;
  try { const id = _bgMod()?.beginBackgroundTask?.('chatyy-status-publish'); return (typeof id === 'number' && id >= 0) ? id : null; } catch { return null; }
}
function _endBg(id) { if (id == null) return; try { _bgMod()?.endBackgroundTask?.(id); } catch {} }

export function newStatusJobId() {
  return `st_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function _snap(j) {
  return {
    id: j.id, email: j.email, kind: j.kind, status: j.status,
    progress: j.progress || 0, error: j.error || null, thumbUri: j.thumbUri || null,
    createdAt: j.createdAt,
  };
}
export function getStatusJobs(email) {
  const e = String(email || '').toLowerCase();
  return Array.from(_jobs.values())
    .filter(j => !e || String(j.email || '').toLowerCase() === e)
    .map(_snap)
    .sort((a, b) => a.createdAt - b.createdAt);
}
// 0..1 da fila ativa (null = nada pendente). Jobs com falha definitiva não contam.
export function getAggregateProgress(email) {
  const act = getStatusJobs(email).filter(j => j.status !== 'done' && j.status !== 'failed');
  if (!act.length) return null;
  return act.reduce((s, j) => s + (j.progress || 0), 0) / act.length;
}
export function hasFailedStatusJobs(email) {
  return getStatusJobs(email).some(j => j.status === 'failed');
}
export function subscribeStatusJobs(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => _subs.delete(fn);
}
export function onStatusPublished(fn) {
  if (typeof fn !== 'function') return () => {};
  _doneSubs.add(fn);
  return () => _doneSubs.delete(fn);
}
function _emit() { for (const fn of Array.from(_subs)) { try { fn(); } catch {} } }

async function _persist() {
  if (Platform.OS === 'web') return;
  try {
    const arr = Array.from(_jobs.values())
      .filter(j => j.status !== 'done')
      .map(({ webFile, ...rest }) => rest);
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(arr));
  } catch {}
}

async function _stageFile(uri, name) {
  const FS = _FS();
  if (!FS?.documentDirectory || !uri) return uri;
  try {
    const dir = FS.documentDirectory + OUTBOX_DIR;
    try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
    const ext = (String(name || '').match(/\.[a-z0-9]+$/i) || ['.bin'])[0];
    const dest = `${dir}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${ext}`;
    await FS.copyAsync({ from: uri, to: dest });
    return dest;
  } catch { return uri; }
}
async function _unstage(job) {
  const FS = _FS();
  if (!FS || !job?.fileUri || !String(job.fileUri).includes(OUTBOX_DIR)) return;
  try { await FS.deleteAsync(job.fileUri, { idempotent: true }); } catch {}
}

/**
 * input: {
 *   email, kind: 'image'|'video'|'text',
 *   file?: { uri, name, type } | File (web), thumbUri?,
 *   content? (texto), background?, music?, meta? (privacy/except_emails/caption/...)
 * }
 */
export async function enqueueStatusPublish(input) {
  const id = input.id || newStatusJobId();
  if (input.email) _currentEmail = String(input.email).toLowerCase();
  const job = {
    id,
    email: input.email || '',
    kind: input.kind || 'image',
    content: input.content || '',
    background: input.background || '#000000',
    music: input.music || null,
    meta: input.meta || {},
    thumbUri: input.thumbUri || null,
    status: 'queued',
    progress: 0,
    attempts: 0,
    uploadedUrls: null,
    createdAt: Date.now(),
  };
  if (job.kind !== 'text') {
    const f = input.file;
    if (Platform.OS === 'web') {
      job.webFile = f;
      job.fileName = f?.name || 'status.jpg';
      job.fileType = f?.type || 'image/jpeg';
    } else {
      job.fileName = f?.name || (job.kind === 'video' ? 'status.mp4' : 'status.jpg');
      job.fileType = f?.type || (job.kind === 'video' ? 'video/mp4' : 'image/jpeg');
      job.fileUri = await _stageFile(f?.uri, job.fileName);
    }
  }
  _jobs.set(id, job);
  _emit();
  _persist();
  _kick();
  return id;
}

export function retryStatusJob(id) {
  const j = _jobs.get(id);
  if (!j || j.status !== 'failed') return;
  j.status = 'queued'; j.attempts = 0; j.error = null;
  _emit(); _persist(); _kick();
}
export async function dismissStatusJob(id) {
  const j = _jobs.get(id);
  if (!j) return;
  _jobs.delete(id);
  await _unstage(j);
  _emit(); _persist();
}

export async function resumeStatusPublishes(email) {
  if (email) _currentEmail = String(email).toLowerCase();
  if (Platform.OS === 'web' || _loaded) { _kick(); return; }
  _loaded = true;
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    for (const j of Array.isArray(arr) ? arr : []) {
      if (!j?.id || _jobs.has(j.id)) continue;
      if (email && j.email && String(j.email).toLowerCase() !== String(email).toLowerCase()) {
        _jobs.set(j.id, j); // outra conta: mantém, mas só roda quando ela estiver ativa
        continue;
      }
      if (j.status !== 'failed') j.status = 'queued';
      _jobs.set(j.id, j);
    }
  } catch {}
  _emit();
  _kick();
}

function _kick() {
  if (_running) return;
  if (_wakeTimer) { clearTimeout(_wakeTimer); _wakeTimer = null; }
  _run();
}

// Conta ativa = a última que chamou enqueue/resume (a faixa de stories chama
// resume no mount com o usuário logado). Jobs de outra conta ficam parados.
function _activeEmail() { return _currentEmail; }
export function setStatusQueueAccount(email) {
  const e = String(email || '').toLowerCase();
  if (e === _currentEmail) return;
  _currentEmail = e;
  _emit();
  _kick();
}

async function _run() {
  _running = true;
  const bg = _beginBg();
  try {
    for (;;) {
      const active = _activeEmail();
      const next = Array.from(_jobs.values())
        .filter(j => j.status === 'queued' && (!active || !j.email || String(j.email).toLowerCase() === active))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      await _process(next);
    }
  } finally {
    _endBg(bg);
    _running = false;
  }
}

function _norm(p) { const n = Number(p) || 0; return n > 1 ? n / 100 : n; }

async function _process(job) {
  const api = _api();
  if (!api) return;
  job.status = job.kind === 'text' ? 'publishing' : 'uploading';
  job.attempts = (job.attempts || 0) + 1;
  job.error = null;
  _emit();
  try {
    if (job.kind === 'text') {
      const r = await api.statusPublish(job.content, 'text', job.background, job.music, job.meta);
      if (!r?.success) throw Object.assign(new Error(r?.message || 'publish failed'), { fatal: _isFatal(r) });
    } else {
      if (!Array.isArray(job.uploadedUrls) || !job.uploadedUrls.length) {
        const file = Platform.OS === 'web'
          ? job.webFile
          : { uri: job.fileUri, name: job.fileName, type: job.fileType };
        if (!file) throw Object.assign(new Error('file lost'), { fatal: true });
        let parts = [file];
        if (job.kind === 'video' && Platform.OS !== 'web') {
          try { parts = await require('./statusVideoSegments').segmentVideoForStatus(file); } catch { parts = [file]; }
        }
        const urls = [];
        for (let i = 0; i < parts.length; i++) {
          const up = await api.statusUpload(parts[i], (p) => {
            job.progress = Math.min(0.9, ((i + _norm(p)) / parts.length) * 0.9);
            _emit();
          });
          if (!(up?.success && up.data?.url)) throw new Error(up?.message || 'upload failed');
          urls.push(up.data.url);
        }
        job.uploadedUrls = urls;
        _persist();
      }
      job.status = 'publishing';
      job.progress = 0.92;
      _emit();
      const type = job.kind === 'video' ? 'video' : 'image';
      const urls = job.uploadedUrls;
      const startAt = job.publishedCount || 0;
      for (let i = startAt; i < urls.length; i++) {
        const meta = i === 0 ? job.meta : { privacy: job.meta?.privacy, except_emails: job.meta?.except_emails };
        const r = await api.statusPublish(urls[i], type, '#000000', i === 0 ? job.music : null, meta);
        if (!r?.success) throw Object.assign(new Error(r?.message || 'publish failed'), { fatal: _isFatal(r) });
        job.publishedCount = i + 1;
        _persist();
      }
    }
    job.status = 'done';
    job.progress = 1;
    _emit();
    for (const fn of Array.from(_doneSubs)) { try { fn(_snap(job)); } catch {} }
    try { const bus = require('../components/statusRefreshBus'); (bus?.default || bus)?.emit?.('refresh'); } catch {}
    await _unstage(job);
    // Some da fila depois que o anel fechar (o strip anima até 100%).
    setTimeout(() => { if (_jobs.get(job.id)?.status === 'done') { _jobs.delete(job.id); _emit(); } }, 1200);
    _persist();
  } catch (e) {
    job.error = e?.message || 'error';
    if (e?.fatal || job.attempts >= MAX_ATTEMPTS) {
      job.status = 'failed';
    } else {
      job.status = 'waiting';
      const delay = Math.min(60000, 2000 * Math.pow(2, job.attempts - 1));
      setTimeout(() => { if (_jobs.get(job.id)?.status === 'waiting') { job.status = 'queued'; _kick(); } }, delay);
    }
    _emit();
    _persist();
  }
}

function _isFatal(r) {
  const m = String(r?.message || '').toLowerCase();
  return /invalid media_url|content or media required|too large|forbidden|not allowed/.test(m);
}

// Volta pro foreground → tenta o que estava esperando rede.
try {
  AppState.addEventListener?.('change', (s) => {
    if (s !== 'active') return;
    let any = false;
    for (const j of _jobs.values()) if (j.status === 'waiting') { j.status = 'queued'; any = true; }
    if (any) _kick();
  });
} catch {}

export default {
  enqueueStatusPublish, resumeStatusPublishes, retryStatusJob, dismissStatusJob,
  getStatusJobs, getAggregateProgress, hasFailedStatusJobs, subscribeStatusJobs, onStatusPublished,
  newStatusJobId, setStatusQueueAccount,
};
