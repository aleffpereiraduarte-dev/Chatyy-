// services/nativeOutbox.js — [2026-10-15 fase 4] FILA DE ENVIO NATIVA
//
// O envio de mensagens (texto e mídia) passa a ser do NATIVO (modules/
// expo-chat-transport: ChatOutbox.swift / OutboxCore.kt), gravado no SQLite da
// conta (modules/expo-chat-store, tabela `outbox`) com o client_message_id ANTES
// de qualquer tentativa:
//   • WS nativo autenticado (frame `chat_send`, ack no mesmo socket) → senão HTTP
//     nativo (URLSession/OkHttp) em `email.php?action=chat_send` (origem US);
//   • app fechado/morto: iOS beginBackgroundTask + BGAppRefreshTask (texto) e
//     URLSession de 2º plano (upload de mídia); Android WorkManager (tudo);
//   • dedupe garantido pelo servidor (remetente + client_message_id);
//   • FIFO por conversa; transitório nunca vira falha; só 4xx definitivo.
//
// O JS continua dono da UI e da fila JS (services/messageOutbox.js): a linha JS
// fica 'sending' e "possuída" pelo nativo (isNativeOwned) até o evento
// onOutboxState 'sent'/'failed' chegar — aí markSent/markFailed + eco local
// (mesmo caminho do sendWorker). Itens enviados com o JS morto são conciliados no
// boot (reconcile). Linhas pendentes da fila JS migram para o nativo pelo próprio
// sendWorker (cada _processRow delega) — ver migratePending().
//
// Fora do nativo (seguem no caminho JS de sempre): web, binário sem o módulo
// (ChatyyTransport version < 2 / store apiVersion < 3), modo envelope / E2EE,
// tópico, meta/replyExt, voz/áudio (servidor transcodifica), mídia > 1 MB (o
// upload em pedaços retomável + bgTransfer já é nativo).
//
// Kill switch (OTA): globalThis.__chatyy_native_outbox = false → tudo volta à
// fila JS (os itens já entregues ao nativo continuam sendo enviados por ele).
import { Platform } from 'react-native';

const DEFAULT_ON = true;
const ORIGIN = 'https://chatyy.com.br';
export const NATIVE_MEDIA_MAX_BYTES = 1024 * 1024;

let _mod; // undefined = não resolvido; null = indisponível
let _sub = null;
let _cfgKey = '';
let _booted = false;
const _owned = new Map(); // cmi → { conv, at } (itens que o nativo está enviando)
const _waiters = new Map(); // cmi → Set<fn(ev)>
const _stats = { submitted: 0, sent: 0, failed: 0, reconciled: 0, migrated: 0, fallbacks: 0, events: 0 };

function _resolve() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return _mod;
  try {
    const { requireOptionalNativeModule } = require('expo');
    const m = requireOptionalNativeModule('ChatyyTransport');
    if (m && typeof m.version === 'function' && m.version() >= 2 && typeof m.outboxSubmit === 'function') {
      // a tabela `outbox` mora no store (apiVersion ≥ 3)
      const st = requireOptionalNativeModule('ChatyyChatStore');
      if (st && typeof st.apiVersion === 'function' && Number(st.apiVersion()) >= 3) _mod = m;
    }
  } catch { _mod = null; }
  return _mod;
}

function _api() { try { return require('./api'); } catch { return null; } }
function _acct() {
  try { return String(_api()?.getActiveAccountEmail?.() || '').trim().toLowerCase(); } catch { return ''; }
}

/** Kill switch + binário com o módulo. */
export function nativeOutboxEnabled() {
  try {
    const o = globalThis.__chatyy_native_outbox;
    if (o === false) return false;
    if (o !== true && !DEFAULT_ON) return false;
  } catch {}
  return !!_resolve();
}

export function nativeOutboxStats() {
  let native = null;
  try { native = _resolve()?.outboxStats?.() || null; } catch {}
  return { ..._stats, owned: _owned.size, native };
}

/**
 * O nativo está com este cmi (a fila JS não precisa recuperar/reenviar). Validade
 * de 10 min sem notícia: depois disso a fila JS reassume (reenvio é idempotente —
 * o nativo deduplica pelo cmi na tabela e o servidor pelo client_message_id).
 */
const OWN_TTL_MS = 10 * 60 * 1000;
export function isNativeOwned(cmi) {
  if (cmi == null) return false;
  const o = _owned.get(String(cmi));
  return !!o && (Date.now() - o.at) < OWN_TTL_MS;
}

/** Credenciais p/ o nativo reenviar sem o JS (Keychain / arquivo privado). Barato se nada mudou. */
export function configureNativeOutbox(force = false) {
  const m = _resolve();
  if (!m) return false;
  const a = _acct();
  let tok = '';
  try { tok = String(_api()?.getToken?.() || ''); } catch {}
  if (!a || !tok) return false;
  const k = a + '|' + tok;
  if (!force && k === _cfgKey) return true;
  try { m.outboxConfigure(a, tok, ORIGIN); _cfgKey = k; return true; } catch { return false; }
}

function _isE2E(p) {
  try { if (globalThis.__chatyy_envelope_mode === true) return true; } catch {}
  return !!(p && (p._e2e || p._e2eWanted || p.e2e || p.envelopes));
}

/** Texto elegível? (payload no formato do chat_send / linha do outbox JS) */
export function canTakeText(p) {
  if (!p || !nativeOutboxEnabled()) return false;
  if (!p.client_message_id || p.conversation_id == null) return false;
  if ((p.type || 'text') !== 'text') return false;
  if (typeof p.content !== 'string' || !p.content.trim()) return false;
  if (_isE2E(p) || p.topic_id || p.file_url) return false;
  const o = p.opts || {};
  if (o.meta || o.replyExt || p.meta || p.reply_ext) return false;
  return true;
}

/** Mídia elegível p/ o COMMIT nativo (bytes já no CDN) ou upload nativo (arquivo local pequeno). */
export function canTakeMedia(p, sizeBytes = 0) {
  if (!p || !nativeOutboxEnabled()) return false;
  if (!p.client_message_id || p.conversation_id == null) return false;
  if (_isE2E(p) || p.view_once || p.voice_session_id) return false;
  const t = String(p.type || '');
  if (!['image', 'video', 'file', 'audio', 'voice', 'video_note'].includes(t)) return false;
  if (p.cdn_url) return true; // só o chat_send
  if (t === 'audio' || t === 'voice' || p.upload_via === 'php') return false; // servidor transcodifica (PHP)
  const n = Number(sizeBytes || p.file_size) || 0;
  return n > 0 && n <= NATIVE_MEDIA_MAX_BYTES;
}

// ─── corpo/frame (mesmos campos do api.chatSend / _tryNativeWsSend) ─────────

function _textBody(p) {
  const o = p.opts || {};
  const b = {
    conversation_id: p.conversation_id,
    content: p.content,
    type: 'text',
    reply_to_id: p.reply_to_id || null,
    client_message_id: p.client_message_id,
  };
  if (p.temp_id) b.temp_id = p.temp_id;
  if (p.mentions) {
    if (typeof p.mentions === 'string') b.mentions = p.mentions;
    else if (Array.isArray(p.mentions) && p.mentions.length) { try { b.mentions = JSON.stringify(p.mentions); } catch {} }
  }
  const effect = p.effect || o.effect;
  if (effect) b.effect = String(effect).toLowerCase();
  if (p.silent || o.silent) b.silent = true;
  const rq = p.reply_quote_text || o.replyQuoteText;
  if (rq && b.reply_to_id) b.reply_quote_text = String(rq).slice(0, 240);
  if (p.sealed || o.sealed) b.sealed = true;
  return b;
}

function _textFrame(b) {
  const f = { type: 'chat_send', conversation_id: b.conversation_id, client_message_id: b.client_message_id, msg_type: 'text', content: b.content };
  for (const k of ['reply_to_id', 'reply_quote_text', 'mentions', 'effect', 'silent', 'sealed']) {
    if (b[k] != null && b[k] !== '') f[k] = b[k];
  }
  return f;
}

function _mediaBody(p, metaFields) {
  const b = {
    conversation_id: p.conversation_id,
    content: p.caption || p.content || '',
    type: p.type || 'file',
    client_message_id: p.client_message_id,
    view_once: p.view_once ? 1 : 0,
    ...(metaFields || {}),
  };
  if (p.temp_id) b.temp_id = p.temp_id;
  if (p.reply_to_id) b.reply_to_id = p.reply_to_id;
  if ((p.opts && p.opts.sealed) || p.sealed) b.sealed = true;
  if (p.cdn_url) {
    b.file_url = p.cdn_url;
    b.file_name = p.server_file_name || p.file_name || 'file';
    b.file_size = p.server_size || p.file_size || 0;
  }
  return b;
}

// ─── envio ──────────────────────────────────────────────────────────────────

async function _submit(item) {
  const m = _resolve();
  const a = _acct();
  if (!m || !a) return '';
  configureNativeOutbox();
  _ensureSub();
  const cmi = String(item.cmi);
  _owned.set(cmi, { conv: String(item.conv), at: Date.now() });
  let st = '';
  try { st = String(await m.outboxSubmit(a, JSON.stringify(item)) || ''); } catch { st = ''; }
  if (!st) { _owned.delete(cmi); return ''; }
  if (st === 'new') _stats.submitted++;
  // já existia: 'failed' → o usuário pediu de novo (requeue) → volta à fila nativa
  if (st === 'failed') { try { m.outboxRetry(a, cmi); } catch {} }
  if (st === 'sent') {
    // já enviado (ex.: JS morreu antes de conciliar) → entrega o resultado a quem
    // espera (ou concilia) — depois do return, p/ o waiter já estar registrado
    setTimeout(() => { _reconcileOne(a, cmi).catch(() => {}); }, 0);
  }
  return st;
}

function _wait(cmi, ms) {
  return new Promise((resolve) => {
    let done = false;
    let tm = null;
    const fn = (ev) => {
      if (done) return;
      if (ev.state !== 'sent' && ev.state !== 'failed') return;
      done = true;
      if (tm) clearTimeout(tm);
      const set = _waiters.get(cmi); if (set) { set.delete(fn); if (!set.size) _waiters.delete(cmi); }
      resolve(ev);
    };
    let set = _waiters.get(cmi);
    if (!set) { set = new Set(); _waiters.set(cmi, set); }
    set.add(fn);
    if (ms > 0 && Number.isFinite(ms)) {
      tm = setTimeout(() => {
        if (done) return;
        done = true;
        const s2 = _waiters.get(cmi); if (s2) { s2.delete(fn); if (!s2.size) _waiters.delete(cmi); }
        resolve(null);
      }, ms);
    }
  });
}

function _resultFromEvent(ev) {
  if (!ev) return null;
  if (ev.state === 'sent') {
    let row = null;
    try { row = JSON.parse(ev.server || '{}'); } catch { row = null; }
    if (!row || row.id == null) return null;
    _rememberSent(row.id);
    return { success: true, data: row, message: 'Message sent', _native_outbox: true, _via: ev.via || '' };
  }
  const err = String(ev.err || 'rejected');
  const m = /^http_(\d{3})/.exec(err);
  const r = { success: false, message: err, error: err, _native_outbox: true };
  try { Object.defineProperty(r, '__httpStatus', { value: m ? Number(m[1]) : 400, enumerable: false }); } catch {}
  return r;
}

function _rememberSent(id) {
  try {
    const g = globalThis;
    if (!g.__chatyy_nativeSentIds) g.__chatyy_nativeSentIds = new Set();
    g.__chatyy_nativeSentIds.add(id);
    if (g.__chatyy_nativeSentIds.size > 500) g.__chatyy_nativeSentIds.delete(g.__chatyy_nativeSentIds.values().next().value);
  } catch {}
}

/**
 * Caminho em primeiro plano (api.chatSend → _tryNativeWsSend). Grava no nativo e
 * espera o ack até `waitMs`. Devolve:
 *   • {success:true, data}            — enviado (WS ou HTTP nativo);
 *   • {success:false, __httpStatus…}  — rejeição definitiva (4xx);
 *   • {success:false, _deferred:true, _native_queued:true} — nativo segue tentando
 *     (rede ruim/offline): a bolha fica no relógio e o evento 'sent' conclui;
 *   • undefined — não entrou no nativo (chamador segue o caminho JS).
 */
export async function sendTextNow(payload, waitMs = 8000) {
  if (!canTakeText(payload)) return undefined;
  const body = _textBody(payload);
  const cmi = String(body.client_message_id);
  const waiting = _wait(cmi, waitMs);
  const st = await _submit({ cmi, conv: String(body.conversation_id), kind: 'text', body, frame: JSON.stringify(_textFrame(body)) });
  if (!st) { _cancelWait(cmi); _stats.fallbacks++; return undefined; }
  const ev = await waiting;
  const r = _resultFromEvent(ev);
  if (r) {
    if (r.success) _ackLater(cmi); else _owned.delete(cmi);
    return r;
  }
  return { success: false, _deferred: true, _native_queued: true, message: 'native_queued', error: 'native_queued' };
}

/**
 * Caminho do sendWorker (linha da fila JS). Espera o resultado FINAL (o nativo
 * trata transitórios sozinho, inclusive com o app no fundo). null = não entrou.
 */
export async function sendRowAndWait(row, metaFields = null) {
  const p = (row && row.payload) || {};
  const cmi = String(row.client_message_id || p.client_message_id || '');
  if (!cmi) return null;
  const pp = { ...p, client_message_id: cmi, conversation_id: p.conversation_id ?? row.conversation_id };
  let item;
  if ((pp.type || 'text') === 'text') {
    if (!canTakeText(pp)) return null;
    const body = _textBody(pp);
    item = { cmi, conv: String(body.conversation_id), kind: 'text', body, frame: JSON.stringify(_textFrame(body)) };
  } else {
    if (!pp.cdn_url) return null; // upload: mediaSendQueue (handoffUpload)
    if (!canTakeMedia(pp)) return null;
    item = { cmi, conv: String(pp.conversation_id), kind: 'media', body: _mediaBody(pp, metaFields) };
  }
  const waiting = _wait(cmi, ROW_WAIT_MS);
  const st = await _submit(item);
  if (!st) { _cancelWait(cmi); _stats.fallbacks++; return null; }
  const ev = await waiting;
  if (!ev) return { success: false, _native_timeout: true, message: 'native_timeout', error: 'native_timeout' };
  const r = _resultFromEvent(ev);
  if (r && r.success) _ackLater(cmi); else _owned.delete(cmi);
  return r;
}
// o worker segura a conversa enquanto espera: teto p/ não travar o FIFO se o
// item nativo sumir (wipe) — depois disso a linha volta à fila e reenvia (idempotente)
const ROW_WAIT_MS = 10 * 60 * 1000;

function _cancelWait(cmi) { _waiters.delete(String(cmi)); }

/**
 * mediaSendQueue: arquivo já preparado (comprimido, cópia durável) e pequeno →
 * o nativo sobe (URLSession de 2º plano / OkHttp no WorkManager) e faz o chat_send.
 * true = assumido (o chamador para; o evento 'sent' conclui via onMediaSent).
 */
export async function handoffUpload(row, p, file, size, metaFields) {
  try {
    const cmi = String(row.client_message_id || p.client_message_id || '');
    const pp = { ...p, client_message_id: cmi, conversation_id: p.conversation_id ?? row.conversation_id };
    if (!cmi || pp.cdn_url || !canTakeMedia(pp, size)) return false;
    const path = String(file?.uri || '');
    if (!path.startsWith('file://') && !path.startsWith('/')) return false;
    const item = {
      cmi, conv: String(pp.conversation_id), kind: 'media',
      body: _mediaBody(pp, metaFields),
      file: path,
      up: { filename: file?.name || pp.file_name || 'file', mime: file?.type || pp.mime_type || 'application/octet-stream', context: 'chat', user_email: _acct() },
    };
    _mediaCtx.set(cmi, { p: pp });
    const st = await _submit(item);
    if (!st) { _mediaCtx.delete(cmi); _stats.fallbacks++; return false; }
    return true;
  } catch { return false; }
}
const _mediaCtx = new Map(); // cmi → { p } (p/ concluir a mídia: cache local, álbum)

function _ackLater(cmi) {
  const m = _resolve();
  const a = _acct();
  if (!m || !a) return;
  _owned.delete(String(cmi));
  setTimeout(() => { try { m.outboxAck(a, String(cmi)); } catch {} }, 0);
}

// ─── eventos do nativo ──────────────────────────────────────────────────────

function _ensureSub() {
  if (_sub) return;
  const m = _resolve();
  if (!m) return;
  try {
    const fn = (ev) => { try { _onEvent(ev || {}); } catch {} };
    if (typeof m.addListener === 'function') _sub = m.addListener('onOutboxState', fn);
    else {
      const { EventEmitter } = require('expo-modules-core');
      _sub = new EventEmitter(m).addListener('onOutboxState', fn);
    }
  } catch { _sub = null; }
}

function _onEvent(ev) {
  _stats.events++;
  const st = ev.state;
  if (st === 'auth_needed') {
    // bearer recusado/ausente → renova e reconfigura (o nativo espera)
    try { const api = _api(); Promise.resolve(api?.refreshAuthToken?.()).finally(() => configureNativeOutbox(true)); } catch {}
    return;
  }
  const cmi = ev.cmi != null ? String(ev.cmi) : '';
  if (!cmi) return;
  const ow = _owned.get(cmi); if (ow) ow.at = Date.now(); // ainda vivo no nativo
  if (st === 'uploaded') { _mediaProgress(cmi, 100, 'commit'); return; }
  if (st === 'uploading') { _mediaProgress(cmi, 50, 'upload'); return; }
  if (st !== 'sent' && st !== 'failed') return;
  const set = _waiters.get(cmi);
  if (set && set.size) { for (const fn of Array.from(set)) { try { fn(ev); } catch {} } return; }
  // ninguém esperando (envio deferido / JS recarregou / mídia): concilia aqui
  _conclude(ev).catch(() => {});
}

function _mediaProgress(cmi, pct, phase) {
  const c = _mediaCtx.get(cmi);
  if (!c) return;
  try { require('./mediaSendQueue').emitProgressExternal?.(c.p, cmi, pct, phase); } catch {}
}

/** Concilia um resultado do nativo com a fila JS + UI (mesmo eco do sendWorker). */
async function _conclude(ev) {
  const cmi = String(ev.cmi);
  const r = _resultFromEvent(ev);
  if (!r) return;
  let mo = null;
  try { mo = require('./messageOutbox'); } catch {}
  const ctx = _mediaCtx.get(cmi);
  _mediaCtx.delete(cmi);
  if (r.success) {
    _stats.sent++;
    const row = r.data;
    let p = ctx ? ctx.p : null;
    if (!p && mo) { try { const s = await mo.getStatus(cmi); p = (s && s.payload) || null; } catch {} }
    try { await mo?.markSent?.(cmi, row.id); } catch {}
    _publish(p, cmi, row, ev.conv);
    if (p && row.file_url) {
      try { await require('./mediaSendQueue').onCommitted?.({ ...p, client_message_id: cmi }, row); } catch {}
    }
    _ackLater(cmi);
  } else {
    _stats.failed++;
    _owned.delete(cmi);
    try { await mo?.markFailed?.(cmi, 'chat_send_rejected:' + (r.message || ''), { kind: 'hard' }); } catch {}
  }
  // álbum: libera as próximas da conversa + acorda o worker
  const conv = ev.conv != null ? ev.conv : (ctx && ctx.p && ctx.p.conversation_id);
  if (conv != null && mo?.promoteReady) {
    try { await mo.promoteReady(Number(conv)); } catch {}
  }
  try { require('./sendWorker').poke?.(); } catch {}
}

function _publish(p, cmi, row, conv) {
  try {
    let me = '';
    try { me = String(_api()?.getActiveAccountEmail?.() || ''); } catch {}
    const serverMsg = { ...row, client_message_id: row.client_message_id || cmi, sender_email: row.sender_email || me, _self: true };
    const cid = (p && p.conversation_id) ?? row.conversation_id ?? conv;
    try {
      const cc = require('./chatCache');
      if (p && p.temp_id) cc.removePendingMessage?.(cid, p.temp_id)?.catch?.(() => {});
      cc.cacheSingleMessage?.(cid, serverMsg)?.catch?.(() => {});
    } catch {}
    try { require('./offlineCache').removeChatSendFromQueueByClientMsgId?.(cmi)?.catch?.(() => {}); } catch {}
    require('./websocket').default?.emit?.('chat_message', { conversation_id: cid, message: serverMsg });
  } catch {}
}

async function _reconcileOne(a, cmi) {
  const m = _resolve();
  if (!m) return;
  let list = [];
  try { list = JSON.parse(String(await m.outboxList(a) || '[]')); } catch { list = []; }
  const it = list.find((x) => String(x.cmi) === String(cmi));
  if (!it) return;
  if (it.state === 'sent' || it.state === 'failed') {
    // quem espera (waiter) recebe; senão concilia
    _onEvent({ cmi: it.cmi, conv: it.conv, state: it.state, server: it.server, err: it.err, via: 'reconcile' });
  }
}

/**
 * Boot / volta do 2º plano: concilia o que o nativo enviou (ou rejeitou) com o JS
 * morto/ocupado e reconstrói o conjunto "possuído pelo nativo".
 */
export async function reconcile() {
  const m = _resolve();
  const a = _acct();
  if (!m || !a) return 0;
  _ensureSub();
  configureNativeOutbox();
  let list = [];
  try { list = JSON.parse(String(await m.outboxList(a) || '[]')); } catch { list = []; }
  let n = 0;
  for (const it of list) {
    const cmi = String(it.cmi || '');
    if (!cmi) continue;
    if (it.state === 'sent' || it.state === 'failed') {
      if (_waiters.has(cmi)) continue;
      try { await _conclude({ cmi, conv: it.conv, state: it.state, server: it.server, err: it.err }); n++; } catch {}
    } else {
      _owned.set(cmi, { conv: String(it.conv), at: Date.now() });
    }
  }
  _stats.reconciled += n;
  try { m.outboxKick('reconcile'); } catch {}
  return n;
}

/**
 * Migração: linhas de TEXTO pendentes na fila JS ('queued') vão para o nativo já
 * (sobrevivem a app morto a partir de agora). Ordem por conversa preservada (seq).
 * Mídia pendente migra quando a mediaSendQueue/sendWorker a processar.
 */
export async function migratePending() {
  if (!nativeOutboxEnabled()) return 0;
  let mo = null;
  try { mo = require('./messageOutbox'); } catch { return 0; }
  let rows = [];
  try { rows = await mo.getPending(null, { lane: 'msg' }); } catch { rows = []; }
  let n = 0;
  for (const r of rows || []) {
    if (r.state !== 'queued') continue;
    const p = r.payload || {};
    if ((p.type || 'text') !== 'text') continue;
    const pp = { ...p, client_message_id: r.client_message_id, conversation_id: p.conversation_id ?? r.conversation_id };
    if (!canTakeText(pp)) continue;
    // a linha JS vira 'sending' possuída pelo nativo; o worker não a pega mais
    let claimed = false;
    try { claimed = await mo.markSending(r.client_message_id); } catch {}
    if (!claimed) continue;
    const body = _textBody(pp);
    const st = await _submit({ cmi: String(r.client_message_id), conv: String(body.conversation_id), kind: 'text', body, frame: JSON.stringify(_textFrame(body)) });
    if (!st) { try { await mo.release?.(r.client_message_id); } catch {} continue; }
    n++;
  }
  _stats.migrated += n;
  return n;
}

/** Chamado no boot do sendWorker (depois do login). Idempotente. */
export function bootNativeOutbox() {
  if (_booted || !nativeOutboxEnabled()) return;
  _booted = true;
  _ensureSub();
  configureNativeOutbox();
  reconcile().then(() => migratePending()).catch(() => {});
}

/** Logout / troca de conta: credenciais fora (a tabela some com o wipe do store). */
export function forgetNativeOutbox() {
  _owned.clear(); _waiters.clear(); _mediaCtx.clear(); _cfgKey = ''; _booted = false;
  const m = _resolve();
  try { m?.outboxForget?.(); } catch {}
}

export default {
  nativeOutboxEnabled, nativeOutboxStats, isNativeOwned, configureNativeOutbox,
  canTakeText, canTakeMedia, sendTextNow, sendRowAndWait, handoffUpload,
  reconcile, migratePending, bootNativeOutbox, forgetNativeOutbox,
};
