// [wa-import-v2 2026-10-13] Importação do WhatsApp EM SEGUNDO PLANO.
//
// A importação vive aqui (módulo, não a tela): sair de /import-whatsapp NÃO cancela;
// o usuário volta para a conversa e continua mandando/recebendo normalmente (o import
// usa chamadas próprias — email.php?action=wa_import_* — e não passa pela fila de envio
// do chat, então nunca fica "na frente" de uma mensagem). Uma importação por vez.
//
//   job.getJob() / job.subscribe(fn) → estado { status, progress, result, error, … }
//   job.prepare(files, opts)  → lê/parseia em fatias (status 'preparing' → 'ready')
//   job.start(opts)           → roda runImport (status 'running' → 'done' | 'error' | 'cancelled')
//   job.pause() / job.resume() / job.cancel() / job.reset()
//
// App em 2º plano: o JS segue enquanto o SO deixar (keep-awake na tela aberta); se a rede
// cair no meio, a chamada falha → ao voltar para o 1º plano a importação retoma sozinha
// (idempotente no servidor). App morto → escolher o mesmo arquivo continua de onde parou.
//
// Também liga o evento WS "history_imported" (1 por importação, vindo do servidor) →
// a conversa aberta recarrega (push_chat_refresh) e o banner atualiza.
import { AppState } from 'react-native';
// [2026-10-15 boot-size] importer (+ zip/fflate/parser/sha256, ~90 KB) só quando uma
// importação começa: este módulo é importado pelo WaImportBanner da lista de
// conversas (caminho do 1º frame) e só precisa dos listeners/estado.
const _importer = () => require('./importer');
import { refreshImports } from './registry';

const IDLE = { status: 'idle', progress: null, result: null, error: null, prepProgress: 0 };
let _job = { ...IDLE };
let _prep = null;
let _opts = null;
let _signal = { cancelled: false, paused: false };
const _subs = new Set();
let _keep = null;
let _lastFiles = null;     // [wa-import-fase2] arquivos do prepare (para retomar após reiniciar)
let _lastPrepOpts = null;

// ── [wa-import-fase2 2026-10-13] Retomar sozinho depois que o app fecha/reinicia ──────────
// No start: cópia do(s) arquivo(s) no armazenamento do app (documentDirectory/wa-import-resume/) +
// opções no AsyncStorage. Ao abrir o app de novo (mesma conta, < 7 dias), prepara e continua de onde
// parou (o servidor é idempotente: nada duplica). Concluiu/cancelou/descartou → apaga a cópia.
// Só no aparelho (web não guarda arquivo). Texto compartilhado sem arquivo não é retomável.
const RESUME_KEY = 'waimp:resume:v1';
const RESUME_MAX_AGE = 7 * 24 * 3600 * 1000;
function _fs() { try { return require('expo-file-system/legacy'); } catch { try { return require('expo-file-system'); } catch { return null; } } }
function _st() { try { return require('@react-native-async-storage/async-storage').default; } catch { return null; } }
function _acct() { try { return String(require('../api').getActiveAccountEmail?.() || '').toLowerCase(); } catch { return ''; } }
async function _clearResume() {
  try {
    const st = _st(); const raw = await st?.getItem(RESUME_KEY);
    await st?.removeItem(RESUME_KEY);
    const j = raw ? JSON.parse(raw) : null;
    const FS = _fs();
    if (j?.dir && FS?.deleteAsync) await FS.deleteAsync(j.dir, { idempotent: true }).catch(() => {});
  } catch {}
}
async function _saveResume(opts) {
  try {
    const { Platform } = require('react-native');
    if (Platform.OS === 'web' || !Array.isArray(_lastFiles) || !_lastFiles.length) return;
    if (_lastFiles.some((f) => !f || !f.uri || typeof f.text === 'string')) return;
    const FS = _fs(); if (!FS?.documentDirectory || !FS.copyAsync) return;
    await _clearResume();
    const dir = FS.documentDirectory + 'wa-import-resume/' + Date.now() + '/';
    await FS.makeDirectoryAsync(dir, { intermediates: true });
    const files = [];
    for (let i = 0; i < _lastFiles.length; i++) {
      const f = _lastFiles[i];
      const to = dir + i + '-' + String(f.name || 'arquivo').replace(/[^\w.\-]+/g, '_').slice(0, 80);
      await FS.copyAsync({ from: f.uri, to });
      files.push({ uri: to, name: f.name || '', mime: f.mime || '', size: f.size || 0 });
    }
    if (_job.status !== 'running' && _job.status !== 'paused') { await FS.deleteAsync(dir, { idempotent: true }).catch(() => {}); return; }
    const { signal: _s, onProgress: _p, ...prepOpts } = _lastPrepOpts || {};
    await _st()?.setItem(RESUME_KEY, JSON.stringify({ v: 1, at: Date.now(), email: String(opts.email || '').toLowerCase(), dir, files, prepOpts, opts }));
  } catch {}
}
let _autoTried = false;
async function _autoResume() {
  if (_autoTried) return; _autoTried = true;
  try {
    const raw = await _st()?.getItem(RESUME_KEY);
    if (!raw) return;
    const j = JSON.parse(raw);
    const me = _acct();
    if (!j || j.v !== 1 || !j.email || !me || j.email !== me || Date.now() - (j.at || 0) > RESUME_MAX_AGE) { await _clearResume(); return; }
    if (_job.status !== 'idle') return;
    const FS = _fs();
    for (const f of j.files || []) { const inf = await FS?.getInfoAsync?.(f.uri).catch(() => null); if (!inf?.exists) { await _clearResume(); return; } }
    await prepare(j.files, j.prepOpts || {});
    await start({ ...j.opts, resumed: true });
  } catch (e) {
    // recusa definitiva do servidor (ex.: unverified/e2ee/peer_imported) ou arquivo ilegível → não tenta de novo
    if (e?.reason || /no_chat_txt|no_messages|zip_|too_big|no_file/.test(String(e?.message || ''))) _clearResume();
  }
}

function _set(patch) {
  _job = { ..._job, ...patch };
  _subs.forEach((fn) => { try { fn(_job); } catch {} });
}

export function getJob() { return _job; }
export function getPrepared() { return _prep; }
export function subscribe(fn) {
  _subs.add(fn);
  _ensureWsHook();
  return () => { _subs.delete(fn); };
}
export function isActive() { return _job.status === 'running' || _job.status === 'paused' || _job.status === 'preparing'; }

export async function prepare(files, opts = {}) {
  if (_job.status === 'running' || _job.status === 'paused') throw new Error('already_running');
  try { _prep?.close?.(); } catch {}
  _prep = null;
  _signal = { cancelled: false, paused: false };
  _lastFiles = files; _lastPrepOpts = opts;
  _set({ ...IDLE, status: 'preparing', originConvId: opts.originConvId || null });
  try {
    const p = await _importer().prepareImport(files, { ...opts, signal: _signal, onProgress: (f) => _set({ prepProgress: f }) });
    _prep = p;
    _set({ status: 'ready', prepProgress: 1, title: p.title });
    return p;
  } catch (e) {
    _set({ status: e?.message === 'cancelled' ? 'idle' : 'error', error: e });
    throw e;
  }
}

async function _keepAwake(on) {
  try {
    if (on) { _keep = require('expo-keep-awake'); await _keep.activateKeepAwakeAsync?.('wa-import'); }
    else { _keep?.deactivateKeepAwake?.('wa-import'); _keep = null; }
  } catch {}
}

// [wa-import-fase2] "Importação concluída (X mensagens)" — notificação LOCAL quando o app não está na frente.
async function _notifyDone(r) {
  try {
    if (AppState.currentState === 'active') return;
    const title = String(_opts?.notifyTitle || '');
    const body = String(_opts?.notifyBody || '').replace('{n}', String(Number(r?.summary?.messages) || 0));
    if (!title) return;
    const N = require('expo-notifications');
    await N.scheduleNotificationAsync({ content: { title, body, data: { type: 'wa_import_done', conversation_id: r?.conversationId || null } }, trigger: null });
  } catch {}
}

async function _run() {
  _signal.cancelled = false;
  _set({ status: _signal.paused ? 'paused' : 'running', error: null });
  _keepAwake(true);
  try {
    // [wa-import-local 2026-10-22] opts.local → só no aparelho (store local; nada de conteúdo ao servidor)
    const runner = _opts && _opts.local ? require('./localImport').runLocalImport : _importer().runImport;
    const r = await runner(_prep, _opts, (p) => {
      _set({ progress: p, conversationId: p.conversationId || _job.conversationId, status: _signal.paused ? 'paused' : 'running' });
    }, _signal);
    if (r.cancelled) { _set({ status: 'cancelled', result: r }); _clearResume(); return r; }
    _set({ status: 'done', result: r, conversationId: r.conversationId });
    refreshImports(true).catch(() => {});
    _clearResume();
    _notifyDone(r);
    return r;
  } catch (e) {
    _set({ status: 'error', error: e });
    throw e;
  } finally {
    _keepAwake(false);
  }
}

/** opts: ver runImport (+ originConvId para o banner). Resolve no fim (a tela não precisa esperar). */
export function start(opts) {
  if (!_prep) return Promise.reject(new Error('not_prepared'));
  if (_job.status === 'running' || _job.status === 'paused') return Promise.reject(new Error('already_running'));
  _opts = { ...opts };
  _signal = { cancelled: false, paused: false };
  _set({ originConvId: opts.originConvId || _job.originConvId || null, targetConversationId: opts.targetConversationId || null, mode: opts.mode || 'copy', title: opts.title || _prep.title, startedAt: Date.now(), result: null });
  const p = _run();
  if (!opts.resumed) _saveResume(_opts); // [wa-import-fase2] cópia p/ retomar após reiniciar (em 2º plano)
  return p;
}

/** Tentar de novo depois de erro (rede/servidor) — mesmo arquivo, sem duplicar. */
export function retry(extraOpts) {
  if (!_prep || !_opts) return Promise.reject(new Error('not_prepared'));
  if (_job.status === 'running') return Promise.resolve(null);
  if (extraOpts) _opts = { ..._opts, ...extraOpts };
  return _run();
}

export function pause() { if (_job.status === 'running') { _signal.paused = true; _set({ status: 'paused' }); } }
export function resume() { if (_job.status === 'paused') { _signal.paused = false; _set({ status: 'running' }); } }
export function cancel() {
  _signal.cancelled = true;
  _signal.paused = false;
  if (_job.status === 'preparing' || _job.status === 'ready') _set({ status: 'idle' });
  _clearResume();
}
export function reset() {
  if (_job.status === 'running' || _job.status === 'paused') return;
  try { _prep?.close?.(); } catch {}
  _prep = null; _opts = null;
  _set({ ...IDLE });
  _clearResume();
}

// ── 2º plano: retoma sozinho ao voltar se parou por rede ─────────────────
let _appStateSub = null;
function _ensureAppState() {
  if (_appStateSub) return;
  try {
    _appStateSub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      const err = _job.error;
      const netLike = err && !err.reason && (!err.status || err.status >= 500 || err.status === 429 || /network|timeout|batch_failed|http_/.test(String(err.message)));
      if (_job.status === 'error' && _prep && _opts && netLike) retry().catch(() => {});
    });
  } catch {}
}
_ensureAppState();
// [wa-import-fase2] retomada após reiniciar: alguns segundos depois do app abrir (conta já carregada).
try { setTimeout(() => { _autoResume().catch(() => {}); }, 6000); } catch {}

// ── Evento único do servidor: history_imported ───────────────────────────
const _convListeners = new Set();
export function onHistoryImported(fn) { _convListeners.add(fn); _ensureWsHook(); return () => _convListeners.delete(fn); }
let _wsHooked = false;
function _ensureWsHook() {
  if (_wsHooked) return;
  try {
    const ws = require('../websocket').default;
    if (!ws?.on) return;
    _wsHooked = true;
    ws.on('history_imported', (data) => {
      const cid = data?.conversation_id;
      if (!cid) return;
      // [import-ordem 2026-10-13] histórico entrou/saiu → conversa passa a ser "por data"
      // e a tela aberta recarrega a JANELA inteira (wa_reset), não só o delta por id.
      try { const co = require('../chatOrder'); co.markTimeOrdered(cid); co.forgetImportRev(cid); } catch {}
      // A conversa aberta já recarrega com push_chat_refresh (chat-conversation).
      try { ws._emit?.('push_chat_refresh', { conversation_id: cid, wa_reset: true }); } catch {}
      try { require('./registry').refreshImports(true).catch(() => {}); } catch {}
      _convListeners.forEach((fn) => { try { fn(data); } catch {} });
    });
  } catch {}
}
