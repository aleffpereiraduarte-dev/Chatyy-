/**
 * driveUploadQueue — [2026-10-16 drive-native] fila DURÁVEL de envio do Cloud/Drive.
 *
 * Antes: o Drive mandava os arquivos num laço dentro da tela, com barra falsa
 * (50% → 100%), sem retomada (fechar a tela/app perdia tudo) e sem distinguir
 * "sem espaço" (507) de erro de rede.
 *
 * Agora:
 *   • cada arquivo vira um item persistido (AsyncStorage, por conta) e copiado
 *     para documentDirectory (o cache do seletor pode ser apagado pelo SO);
 *   • o envio é o PUT direto no R2 com URL pré-assinada (sem expor URL pública),
 *     feito pela sessão NATIVA do expo-file-system (createUploadTask,
 *     sessionType BACKGROUND → URLSession de fundo no iOS; Android segue com a
 *     tela apagada) com progresso REAL em bytes;
 *   • ao abrir o app de novo, item "enviando" com file_id é confirmado
 *     (drive_confirm_upload faz HEAD no R2: se o objeto chegou → pronto; se não,
 *     o servidor apaga o registro fantasma e o item volta para a fila);
 *   • 507 (cota) para a fila e avisa a tela (botão "Comprar armazenamento");
 *     413 (arquivo acima do limite do plano) = erro definitivo do item.
 *
 * Web: mesma API, mas em memória (File do navegador não sobrevive a recarregar).
 * Kill switch (OTA/console): globalThis.__chatyy_drive_queue = false → a tela
 * usa o laço antigo.
 */
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from './api';

const CONCURRENCY = 2;
const MAX_ATTEMPTS = 4;
const KEY_PREFIX = '@chatyy_drive_upq:';

let _account = '';
let _items = [];            // [{ id, name, mime, size, folderId, uri, state, progress, fileId, attempts, error, createdAt }]
let _loaded = false;
let _running = 0;
let _paused = false;        // true após 507 até o usuário tentar de novo
const _listeners = new Set();
const _quotaListeners = new Set();
const _doneListeners = new Set();
const _webFiles = new Map(); // id -> File (web)
const _tasks = new Map();    // id -> UploadTask (nativo) | XHR (web)
let _appSub = null;
let _persistTimer = null;

export function isDriveQueueEnabled() {
  try { if (globalThis.__chatyy_drive_queue === false) return false; } catch {}
  return true;
}

function _key() { return KEY_PREFIX + (_account || 'anon'); }

function _snapshot() { return _items.map((i) => ({ ...i })); }

function _emit() {
  const snap = _snapshot();
  for (const l of Array.from(_listeners)) { try { l(snap); } catch {} }
}

function _persist() {
  if (Platform.OS === 'web') return;
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    const keep = _items.filter((i) => i.state !== 'done').map(({ progress, ...rest }) => rest);
    AsyncStorage.setItem(_key(), JSON.stringify(keep)).catch(() => {});
  }, 250);
}

function _update(id, patch) {
  let changed = false;
  _items = _items.map((i) => {
    if (i.id !== id) return i;
    changed = true;
    return { ...i, ...patch };
  });
  if (changed) { _emit(); if (!('progress' in patch) || Object.keys(patch).length > 1) _persist(); }
}

function _fs() {
  try { return require('expo-file-system/legacy'); } catch { return null; }
}

function _uid() {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function _isQuota(res) {
  if (!res) return false;
  if (res.status === 507 || res?.data?.grace_expired) return true;
  return /armazenamento esgotado|storage quota|espaco de armazenamento/i.test(String(res.message || ''));
}

function _isTooLarge(res) {
  return !!res && (res.status === 413 || res?.data?.code === 'file_too_large');
}

/** Conta atual (troca de conta = outra fila; a antiga fica guardada para quando voltar). */
export async function setAccount(email) {
  const e = String(email || '').toLowerCase().trim();
  if (e === _account && _loaded) return;
  _account = e;
  _loaded = false;
  _items = [];
  _paused = false;
  if (Platform.OS !== 'web') {
    try {
      const raw = await AsyncStorage.getItem(_key());
      const list = raw ? JSON.parse(raw) : [];
      if (Array.isArray(list)) {
        // 'uploading' de uma sessão anterior → 'verify' (confere no servidor antes de reenviar)
        const st = (x) => ((x === 'uploading' || x === 'verifying') ? 'verify' : (x === 'waiting' ? 'queued' : x));
        _items = list.map((i) => ({ ...i, progress: 0, state: st(i.state) }));
      }
    } catch {}
  }
  _loaded = true;
  _ensureAppState();
  _emit();
  _pump();
}

function _ensureAppState() {
  if (_appSub || Platform.OS === 'web') return;
  try {
    _appSub = AppState.addEventListener('change', (s) => { if (s === 'active') _pump(); });
  } catch {}
}

export function subscribe(listener) {
  _listeners.add(listener);
  try { listener(_snapshot()); } catch {}
  return () => _listeners.delete(listener);
}

/** Avisado quando o servidor responde 507 (sem espaço). */
export function onQuotaExceeded(listener) {
  _quotaListeners.add(listener);
  return () => _quotaListeners.delete(listener);
}

/** Avisado quando um item termina (para a tela recarregar a pasta). */
export function onItemDone(listener) {
  _doneListeners.add(listener);
  return () => _doneListeners.delete(listener);
}

export function getItems() { return _snapshot(); }

/**
 * Enfileira arquivos. `files`: [{ uri?, file? (web File), name, mimeType?, size? }].
 * Retorna os ids criados.
 */
export async function enqueue(files, folderId = null) {
  const FS = _fs();
  const ids = [];
  for (const f of files || []) {
    if (!f) continue;
    const id = _uid();
    const name = String(f.name || f.fileName || 'arquivo').slice(0, 200);
    const mime = f.mimeType || f.type || 'application/octet-stream';
    let size = Number(f.size || f.fileSize || f?.file?.size || 0) || 0;
    let uri = f.uri || '';
    if (Platform.OS === 'web') {
      const raw = f.file || f._raw || null;
      if (raw) { _webFiles.set(id, raw); size = size || raw.size || 0; }
      else if (!uri) continue;
    } else if (FS && uri) {
      // Cópia própria: o cache do seletor pode sumir antes de terminarmos.
      try {
        const dir = FS.documentDirectory + 'drive-upq/';
        await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
        const safe = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-80);
        const dest = `${dir}${id}-${safe}`;
        await FS.copyAsync({ from: uri, to: dest });
        uri = dest;
        if (!size) { const inf = await FS.getInfoAsync(dest); size = Number(inf?.size) || 0; }
      } catch { /* sem cópia: envia do original */ }
    }
    _items.push({ id, name, mime, size, folderId: folderId || null, uri, state: 'queued', progress: 0, fileId: null, attempts: 0, error: '', createdAt: Date.now() });
    ids.push(id);
  }
  _paused = false;
  _emit();
  _persist();
  _pump();
  return ids;
}

export function retry(id) {
  _paused = false;
  if (id) _update(id, { state: 'queued', error: '', attempts: 0, progress: 0 });
  else _items = _items.map((i) => (i.state === 'error' || i.state === 'quota') ? { ...i, state: 'queued', error: '', attempts: 0, progress: 0 } : i);
  _emit(); _persist(); _pump();
}

export function cancel(id) {
  const t = _tasks.get(id);
  if (t) { try { t.cancelAsync ? t.cancelAsync() : t.abort?.(); } catch {} _tasks.delete(id); }
  const it = _items.find((i) => i.id === id);
  _items = _items.filter((i) => i.id !== id);
  _webFiles.delete(id);
  _cleanupFile(it);
  _emit(); _persist();
}

/** Tira da lista os concluídos (a barra some). */
export function clearFinished() {
  _items = _items.filter((i) => i.state !== 'done');
  _emit(); _persist();
}

function _cleanupFile(it) {
  if (!it || Platform.OS === 'web' || !it.uri) return;
  if (!/drive-upq\//.test(it.uri)) return;
  const FS = _fs();
  if (FS) FS.deleteAsync(it.uri, { idempotent: true }).catch(() => {});
}

function _finish(it, ok, patch = {}) {
  _update(it.id, { ...patch, state: ok ? 'done' : (patch.state || 'error'), progress: ok ? 100 : 0 });
  _tasks.delete(it.id);
  if (ok) {
    _webFiles.delete(it.id);
    _cleanupFile(it);
    for (const l of Array.from(_doneListeners)) { try { l({ ...it, ...patch }); } catch {} }
  }
}

function _pump() {
  if (!_loaded || _paused) return;
  while (_running < CONCURRENCY) {
    const next = _items.find((i) => i.state === 'queued' || i.state === 'verify');
    if (!next) break;
    _running++;
    _update(next.id, { state: next.state === 'verify' ? 'verifying' : 'uploading', progress: 0 });
    _run(next).catch(() => {}).finally(() => { _running--; _pump(); });
  }
}

async function _run(item) {
  // 1) Item que estava no ar quando o app fechou: o objeto pode ter chegado.
  if (item.state === 'verify' && item.fileId) {
    try {
      const c = await api.confirmUpload(item.fileId);
      if (c?.success) { _finish(item, true); return; }
    } catch {}
    _update(item.id, { fileId: null, state: 'uploading' });
  }
  let bgTask = -1;
  const BU = (() => { try { return require('../modules/expo-background-upload').default; } catch { return null; } })();
  try { if (Platform.OS === 'ios' && BU?.beginBackgroundTask) bgTask = BU.beginBackgroundTask('drive-upload'); } catch {}
  try {
    // 2) URL pré-assinada (servidor confere cota + limite por arquivo com o tamanho real)
    const init = await api.getPresignedUpload(item.name, item.mime, item.folderId, item.size, 'drive');
    if (_isQuota(init)) {
      _paused = true;
      _finish(item, false, { state: 'quota', error: 'quota' });
      for (const l of Array.from(_quotaListeners)) { try { l(init?.data || {}); } catch {} }
      return;
    }
    if (_isTooLarge(init)) { _finish(item, false, { error: init?.message || 'file_too_large' }); return; }
    if (init?.success && init?.data?.deduped) { _finish(item, true, { fileId: init.data.file_id }); return; }
    if (!init?.success || !init?.data?.upload_url) {
      // Pré-assinatura indisponível → caminho antigo pelo servidor (sem progresso fino).
      const legacy = await api.fileUpload(Platform.OS === 'web'
        ? { _raw: _webFiles.get(item.id), name: item.name }
        : { uri: item.uri, name: item.name, mimeType: item.mime }, item.folderId);
      if (_isQuota(legacy)) {
        _paused = true;
        _finish(item, false, { state: 'quota', error: 'quota' });
        for (const l of Array.from(_quotaListeners)) { try { l(legacy?.data || {}); } catch {} }
        return;
      }
      if (legacy?.success) _finish(item, true); else _retryLater(item, legacy?.message || 'upload_failed');
      return;
    }
    const fileId = init.data.file_id || null;
    _update(item.id, { fileId });
    // 3) PUT no R2 com progresso real
    try {
      await _put(item, init.data.upload_url);
    } catch (putErr) {
      if (String(putErr?.message || '') === 'cancelled') throw putErr;
      // R2 inalcançável (CORS/rede corporativa/proxy): mesmo comportamento do caminho
      // antigo — limpa o registro pendente (confirm apaga o "fantasma" sem objeto) e
      // envia pelo servidor.
      if (fileId) { try { await api.confirmUpload(fileId); } catch {} }
      _update(item.id, { fileId: null, progress: 50 });
      const legacy = await api.fileUpload(Platform.OS === 'web'
        ? { _raw: _webFiles.get(item.id), name: item.name }
        : { uri: item.uri, name: item.name, mimeType: item.mime }, item.folderId);
      if (_isQuota(legacy)) {
        _paused = true;
        _finish(item, false, { state: 'quota', error: 'quota' });
        for (const l of Array.from(_quotaListeners)) { try { l(legacy?.data || {}); } catch {} }
        return;
      }
      if (!legacy?.success) throw new Error(legacy?.message || putErr?.message || 'upload_failed');
      _finish(item, true);
      return;
    }
    // 4) Confirma (HEAD no R2 + tamanho/miniatura no servidor)
    if (fileId) {
      const c = await api.confirmUpload(fileId);
      if (!c?.success) throw new Error(c?.message || 'confirm_failed');
    }
    _finish(item, true, { fileId });
  } catch (e) {
    if (String(e?.message || '') === 'cancelled') return;
    _retryLater(item, e?.message || 'upload_failed');
  } finally {
    try { if (bgTask >= 0) BU?.endBackgroundTask?.(bgTask); } catch {}
  }
}

function _retryLater(item, msg) {
  const cur = _items.find((i) => i.id === item.id);
  if (!cur) return;
  const attempts = (cur.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) { _finish(cur, false, { error: String(msg || 'upload_failed'), attempts }); return; }
  _update(cur.id, { state: 'waiting', attempts, error: String(msg || ''), progress: 0 });
  setTimeout(() => {
    const again = _items.find((i) => i.id === cur.id);
    if (again && again.state === 'waiting') { _update(cur.id, { state: 'queued' }); _pump(); }
  }, Math.min(30000, 2000 * 2 ** attempts));
}

function _put(item, url) {
  const onPct = (pct) => _update(item.id, { progress: Math.max(1, Math.min(99, Math.round(pct))) });
  if (Platform.OS === 'web') {
    return new Promise((resolve, reject) => {
      const body = _webFiles.get(item.id);
      if (!body) { reject(new Error('file_lost')); return; }
      const xhr = new XMLHttpRequest();
      _tasks.set(item.id, xhr);
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('Content-Type', item.mime);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) onPct((e.loaded / e.total) * 100); };
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`r2_${xhr.status}`)));
      xhr.onerror = () => reject(new Error('network'));
      xhr.onabort = () => reject(new Error('cancelled'));
      xhr.send(body);
    });
  }
  const FS = _fs();
  if (!FS?.createUploadTask) return Promise.reject(new Error('no_fs'));
  const task = FS.createUploadTask(url, item.uri, {
    httpMethod: 'PUT',
    uploadType: FS.FileSystemUploadType?.BINARY_CONTENT ?? 0,
    sessionType: FS.FileSystemSessionType?.BACKGROUND ?? 0,
    headers: { 'Content-Type': item.mime },
  }, (p) => {
    const sent = Number(p?.totalBytesSent) || 0;
    const total = Number(p?.totalBytesExpectedToSend) || item.size || 0;
    if (total > 0) onPct((sent / total) * 100);
  });
  _tasks.set(item.id, task);
  return task.uploadAsync().then((r) => {
    if (!r) throw new Error('cancelled');
    if (r.status < 200 || r.status >= 300) throw new Error(`r2_${r.status}`);
  });
}
