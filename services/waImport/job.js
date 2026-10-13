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
import { prepareImport, runImport } from './importer';
import { refreshImports } from './registry';

const IDLE = { status: 'idle', progress: null, result: null, error: null, prepProgress: 0 };
let _job = { ...IDLE };
let _prep = null;
let _opts = null;
let _signal = { cancelled: false, paused: false };
const _subs = new Set();
let _keep = null;

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
  _set({ ...IDLE, status: 'preparing', originConvId: opts.originConvId || null });
  try {
    const p = await prepareImport(files, { ...opts, signal: _signal, onProgress: (f) => _set({ prepProgress: f }) });
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

async function _run() {
  _signal.cancelled = false;
  _set({ status: _signal.paused ? 'paused' : 'running', error: null });
  _keepAwake(true);
  try {
    const r = await runImport(_prep, _opts, (p) => {
      _set({ progress: p, conversationId: p.conversationId || _job.conversationId, status: _signal.paused ? 'paused' : 'running' });
    }, _signal);
    if (r.cancelled) { _set({ status: 'cancelled', result: r }); return r; }
    _set({ status: 'done', result: r, conversationId: r.conversationId });
    refreshImports(true).catch(() => {});
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
  return _run();
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
}
export function reset() {
  if (_job.status === 'running' || _job.status === 'paused') return;
  try { _prep?.close?.(); } catch {}
  _prep = null; _opts = null;
  _set({ ...IDLE });
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
      // A conversa aberta já recarrega com push_chat_refresh (chat-conversation).
      try { ws._emit?.('push_chat_refresh', { conversation_id: cid }); } catch {}
      try { require('./registry').refreshImports(true).catch(() => {}); } catch {}
      _convListeners.forEach((fn) => { try { fn(data); } catch {} });
    });
  } catch {}
}
