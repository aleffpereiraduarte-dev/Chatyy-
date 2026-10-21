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
// tópico, meta/replyExt, voz/áudio (servidor transcodifica), mídia > 8 MB (o
// upload em pedaços retomável + bgTransfer já é nativo).
//
// Kill switch (OTA): globalThis.__chatyy_native_outbox = false → tudo volta à
// fila JS (os itens já entregues ao nativo continuam sendo enviados por ele).
import { Platform, AppState } from 'react-native';

const DEFAULT_ON = true;
const ORIGIN = 'https://chatyy.com.br';
// [2026-10-18 native-8mb] 1 → 8 MB. Both native uploaders stream the file
// (iOS background URLSession uploadTask(fromFile:), Android OkHttp
// File.asRequestBody with 5 min write / 6 min call timeout) and the server's
// single POST (/api/rust/upload) accepts 200 MB, so 1–8 MB no longer depends on
// JS being alive. Only on fast links (mediaSendQueue checks _slowLink()).
export const NATIVE_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

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
  // [e2ee5 WP-08c] E2EE v5 decide pelo e2ee_mode da CONVERSA (não por flag no payload): envelope
  // pronto (o JS cifrou) entra na fila nativa só com binário que trata E2EE (WP-08a/08b:
  // e2eeNativeVersion ≥ 1 → WS só com cap e2ee5_ns, recusas §5.4). Texto puro de conversa E2EE nunca.
  try {
    const e5 = require('./e2ee/e2ee5');
    if (p && e5.isOn() && (e5.isConvE2eeSync(p.conversation_id) || e5.isEnvelope(p.content))) {
      if (!e5.isEnvelope(p.content)) return true;
      const m = _resolve();
      return !(m && typeof m.e2eeNativeVersion === 'function' && Number(m.e2eeNativeVersion()) >= 1);
    }
  } catch {}
  return !!(p && (p._e2e || p._e2eWanted || p.e2e || p.envelopes));
}

/** Texto elegível? (payload no formato do chat_send / linha do outbox JS) */
export function canTakeText(p) {
  if (!p || !nativeOutboxEnabled()) return false;
  if (!p.client_message_id || p.conversation_id == null) return false;
  if (isNativeRescued(p.client_message_id)) return false; // [conectando 2026-10-20] o JS assumiu
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
  if (p.topic_id) b.topic_id = p.topic_id; // [2026-10-21 tg4] tópico do grupo
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
  // [conectando 2026-10-20] outboxSubmit é AsyncFunction (fila do módulo): se a
  // fila nativa travar, o await nunca voltava e o envio ficava pendurado sem
  // timer nenhum (o _wait só começa a valer depois do submit). Teto de 3 s →
  // '' = "não entrou" → o chamador segue o caminho JS (mesmo cmi; o servidor
  // deduplica se o nativo acordar depois e mandar também).
  try {
    const _subP = Promise.resolve(m.outboxSubmit(a, JSON.stringify(item)));
    const _to = new Promise((r) => setTimeout(() => r('__submit_timeout'), SUBMIT_TIMEOUT_MS));
    st = String((await Promise.race([_subP, _to])) || '');
    if (st === '__submit_timeout') {
      st = '';
      _stallBeacon('submit_timeout', cmi, { age: SUBMIT_TIMEOUT_MS });
      _markRescued(cmi);
      // se o nativo aceitar depois, tira de lá (o JS já é o dono)
      _subP.then((late) => { if (late) { try { m.outboxCancel(a, cmi); } catch {} } }).catch(() => {});
    }
  } catch { st = ''; }
  if (!st) { _owned.delete(cmi); return ''; }
  if (item.kind === 'text' && st !== 'sent') _watchAdd(cmi, item.conv, a);
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
      if (ev.state !== 'sent' && ev.state !== 'failed' && ev.state !== 'rescued') return;
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
  if (!ev || ev.state === 'rescued') return null;
  if (ev.state === 'sent') {
    let row = null;
    try { row = JSON.parse(ev.server || '{}'); } catch { row = null; }
    if (!row || row.id == null) return null;
    _rememberSent(row.id);
    // [2026-10-16 multi-região fase 4] ✓ da casa regional antes do apply (linha
    // sem conv_pts): a fila JS segura a linha ('accepted') até a cópia canônica —
    // o item nativo pode ser apagado (ack) porque o reenvio, se preciso, sai da
    // fila JS com o mesmo cmi (regionalAccept). Antes do markSent de quem espera.
    try {
      const cmi = ev.cmi != null ? String(ev.cmi) : '';
      const ls = require('./leafSeq');
      const ra = require('./regionalAccept');
      if (cmi && ls.enabled() && ls.isPreApplyRow(row)) ra.noteLocalSeq(cmi, { conversationId: row.conversation_id ?? ev.conv, id: row.id });
      else if (cmi) ra.noteCanonical(cmi);
    } catch {}
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
    g.__chatyy_nativeSentIds.add(String(id)); // [ids-53bit] chave string
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
  if (ev && ev.state === 'rescued') return undefined; // vigia: nativo parado → caminho JS
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
  if (isNativeRescued(cmi)) return null; // [conectando 2026-10-20] o JS assumiu este cmi
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
  if (ev && ev.state === 'rescued') return null; // vigia: nativo parado → caminho JS (mesmo cmi)
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
    const up = { filename: file?.name || pp.file_name || 'file', mime: file?.type || pp.mime_type || 'application/octet-stream', context: 'chat', user_email: _acct() };
    // [2026-10-18 media-wa] Upload to the nearest media edge (BR/EU/Asia) when it
    // advertises the local pipeline — phone→SP instead of phone→US measured
    // ~0.7 s less per photo from Brazil. The edge forwards to the US Rust if its
    // own R2 PUT fails, so a regional base never strands the native retry loop.
    // The chat_send commit still goes to the account's configured base.
    try {
      // probe is cached 10 min; never hold the photo more than ~0.8 s for it.
      const rb = await Promise.race([
        Promise.resolve(_api()?.pickRegionalMediaBase?.()).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 800)),
      ]);
      if (rb && /^https:\/\/([a-z0-9-]+\.)?chatyy\.com\.br$/i.test(String(rb).replace(/\/+$/, ''))) up.base = String(rb).replace(/\/+$/, '');
    } catch {}
    const item = {
      cmi, conv: String(pp.conversation_id), kind: 'media',
      body: _mediaBody(pp, metaFields),
      file: path,
      up,
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

// ─── [conectando 2026-10-20] vigia de texto parado no nativo ────────────────
// Caso real (founder, iPhone b752, 20/10 22:06:56Z, logo após a ligação com o
// Carlos): a mensagem entrou na fila nativa e o nativo NÃO mandou nada (nem
// frame no WS — o socket nativo estava autenticado no hub — nem HTTP) por 56 s;
// a fila JS esperava o resultado por até 10 min (ROW_WAIT_MS) segurando a
// conversa. Só saiu quando o app foi fechado e aberto (processo novo → 36 ms).
// Agora, com o app em 1º plano: nativo calado por STALL_KICK_MS → outboxKick;
// calado por STALL_RESCUE_MS (ou item com ≥ STALL_MAX_AGE_MS e o WS JS
// autenticado) → o JS assume: tira o item do nativo (outboxCancel), libera quem
// espera (estado 'rescued') e a linha volta à fila JS (mesmo client_message_id —
// hub/PHP deduplicam se o nativo ainda mandar). Beacon 'outbox_native_stall' com
// o retrato do nativo (outboxStats/estado do item/rede) p/ achar a causa nativa.
// Kill: globalThis.__chatyy_native_stall_rescue = false.
const SUBMIT_TIMEOUT_MS = 3000;
const STALL_KICK_MS = 6000;
const STALL_RESCUE_MS = 12000;
const STALL_MAX_AGE_MS = 25000;
const RESCUED_TTL_MS = 10 * 60 * 1000;
const _watch = new Map(); // cmi → { at, last, kicked, conv, acct, st }
const _rescued = new Map(); // cmi → ts
let _watchTimer = null;
let _watchAppSub = null;
let _stallBeacons = 0;

function _stallOff() {
  try { return globalThis.__chatyy_native_stall_rescue === false; } catch { return false; }
}
export function isNativeRescued(cmi) {
  if (cmi == null) return false;
  const k = String(cmi);
  const t = _rescued.get(k);
  if (!t) return false;
  if (Date.now() - t > RESCUED_TTL_MS) { _rescued.delete(k); return false; }
  return true;
}
function _markRescued(cmi) {
  _rescued.set(String(cmi), Date.now());
  if (_rescued.size > 200) _rescued.delete(_rescued.keys().next().value);
}
function _watchAdd(cmi, conv, acct) {
  if (_stallOff()) return;
  const now = Date.now();
  _watch.set(String(cmi), { at: now, last: now, kicked: false, conv: String(conv), acct, st: 'queued' });
  _armWatch();
}
function _watchTouch(cmi, st) {
  const w = _watch.get(String(cmi));
  if (w) { w.last = Date.now(); if (st) w.st = st; }
}
function _watchDone(cmi) { _watch.delete(String(cmi)); }
function _armWatch() {
  if (!_watchAppSub) {
    try {
      // Volta ao 1º plano: o nativo merece uma chance limpa (ele também acorda
      // no foreground) — o relógio do vigia recomeça a contar daqui.
      _watchAppSub = AppState.addEventListener?.('change', (s) => {
        if (s !== 'active') return;
        const now = Date.now();
        for (const w of _watch.values()) { w.last = now; w.at = Math.max(w.at, now - STALL_MAX_AGE_MS + STALL_RESCUE_MS); w.kicked = false; }
      }) || null;
    } catch { _watchAppSub = null; }
  }
  if (_watchTimer || !_watch.size) return;
  _watchTimer = setInterval(() => { _watchTick().catch(() => {}); }, 2000);
}
function _wsAuthed() {
  try { const ws = require('./websocket').default; return !!(ws && ws.authenticated && !ws.destroyed); } catch { return false; }
}
async function _watchTick() {
  if (!_watch.size || _stallOff()) {
    if (_watchTimer) { clearInterval(_watchTimer); _watchTimer = null; }
    return;
  }
  try { if (AppState.currentState && AppState.currentState !== 'active') return; } catch {} // 2º plano: o nativo é o dono (BGTask)
  const m = _resolve();
  const now = Date.now();
  for (const [cmi, w] of Array.from(_watch.entries())) {
    const idle = now - w.last;
    const age = now - w.at;
    if (!w.kicked && idle >= STALL_KICK_MS) {
      w.kicked = true;
      try { m?.outboxKick?.('js_stall'); } catch {}
      continue;
    }
    if (w.kicked && (idle >= STALL_RESCUE_MS || (age >= STALL_MAX_AGE_MS && _wsAuthed()))) {
      await _rescue(cmi, w, idle, age);
    }
  }
}
async function _rescue(cmi, w, idle, age) {
  const m = _resolve();
  // O nativo pode ter terminado e o evento se perdeu: confere a lista primeiro.
  let it = null;
  try {
    const list = JSON.parse(String((await Promise.race([
      Promise.resolve(m?.outboxList?.(w.acct)),
      new Promise((r) => setTimeout(() => r('[]'), 1500)),
    ])) || '[]'));
    it = (list || []).find((x) => String(x.cmi) === cmi) || null;
  } catch { it = null; }
  if (!_watch.has(cmi)) return; // concluiu enquanto lia
  if (it && (it.state === 'sent' || it.state === 'failed')) {
    _watchDone(cmi);
    _onEvent({ cmi: it.cmi, conv: it.conv, state: it.state, server: it.server, err: it.err, via: 'stall_reconcile' });
    return;
  }
  _watchDone(cmi);
  _markRescued(cmi);
  _owned.delete(cmi);
  _stallBeacon('rescue', cmi, { idle, age, it, st: w.st });
  try { m?.outboxCancel?.(w.acct, cmi); } catch {}
  const set = _waiters.get(cmi);
  if (set && set.size) {
    // sendRowAndWait (sendWorker) → null → caminho JS do próprio worker
    for (const fn of Array.from(set)) { try { fn({ cmi, conv: w.conv, state: 'rescued' }); } catch {} }
  } else {
    // envio de 1º plano já devolveu "_deferred" (relógio): a linha JS está
    // 'sending' possuída pelo nativo → volta à fila JS e o worker manda já.
    try { await require('./messageOutbox').markFailed?.(cmi, 'native_stall', { kind: 'transient' }); } catch {}
  }
  try { require('./sendWorker').kick?.('native_stall'); } catch {}
}
function _stallBeacon(kind, cmi, x = {}) {
  try {
    if (_stallBeacons >= 6) return;
    _stallBeacons++;
    const m = _resolve();
    let ns = null; let ts = null;
    try { ns = m?.outboxStats?.() || null; } catch {}
    try { ts = m?.getStats?.() || null; } catch {}
    const pick = (o, ks) => (o ? ks.map((k) => `${k}=${o[k] != null ? o[k] : '-'}`).join(',') : '-');
    const it = x.it || null;
    const info = `k=${kind} idle=${Math.round(x.idle || 0)} age=${Math.round(x.age || 0)} st=${x.st || '-'}`
      + ` nst=${it ? it.state : '-'} tries=${it ? (it.tries ?? '-') : '-'} err=${it && it.err ? String(it.err).slice(0, 40) : '-'}`
      + ` ws=${_wsAuthed() ? 1 : 0} ns=[${pick(ns, ['busy', 'inflight', 'attempts', 'wsSends', 'wsTimeouts', 'httpSends', 'transient', 'offlineRetries', 'kicks'])}]`
      + ` ts=[${pick(ts, ['netUp', 'netLost', 'netChanges'])}]`;
    require('./crashReporter').reportStep('outbox_native_stall', info);
  } catch {}
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
  if (st === 'sent' || st === 'failed') _watchDone(cmi); else _watchTouch(cmi, st);
  if (st === 'uploaded') { _mediaProgress(cmi, 100, 'commit', ev.conv); return; }
  // [2026-10-18 outbox-progress] Binário ≥ 3: bytes REAIS enviados pelo
  // uploader nativo (URLSession didSendBodyData / OkHttp RequestBody). 100% dos
  // bytes ≠ concluído (o servidor ainda grava no R2) → teto 99 até 'uploaded'.
  if (st === 'progress') {
    const tot = Number(ev.total) || 0;
    const raw = tot > 0 ? ((Number(ev.sent) || 0) / tot) * 100 : (Number(ev.pct) || 0);
    _mediaProgress(cmi, Math.max(0, Math.min(99, Math.round(raw))), 'upload', ev.conv);
    return;
  }
  // binário antigo (sem 'progress'): mantém o degrau de 50%
  if (st === 'uploading') { if (!_hasNativeProgress()) _mediaProgress(cmi, 50, 'upload', ev.conv); return; }
  if (st !== 'sent' && st !== 'failed') return;
  const set = _waiters.get(cmi);
  if (set && set.size) { for (const fn of Array.from(set)) { try { fn(ev); } catch {} } return; }
  // ninguém esperando (envio deferido / JS recarregou / mídia): concilia aqui
  _conclude(ev).catch(() => {});
}

let _progressCap; // undefined = não verificado
function _hasNativeProgress() {
  if (_progressCap !== undefined) return _progressCap;
  let v = false;
  try { const m = _resolve(); v = !!(m && typeof m.version === 'function' && Number(m.version()) >= 3); } catch { v = false; }
  _progressCap = v;
  return v;
}

/** [2026-10-18] Binário reporta bytes reais ('progress', transport ≥ 3)? */
export function hasNativeProgress() { return _hasNativeProgress(); }

function _mediaProgress(cmi, pct, phase, conv) {
  const c = _mediaCtx.get(cmi);
  // [2026-10-18 restore] Sem contexto em memória = upload entregue ao nativo num
  // processo ANTERIOR (app reaberto). A bolha reidratada do outbox (relógio +
  // anel) escuta pelo cmi → emite mesmo assim com a conversa do evento, senão o
  // anel ficava parado em 0 até o 'sent'.
  // O payload (temp_id: a tela indexa o anel por ele) vem da fila JS uma vez.
  if (!c) { _restoreMediaCtx(cmi, conv, pct, phase); return; }
  try { require('./mediaSendQueue').emitProgressExternal?.(c.p, cmi, pct, phase); } catch {}
}
const _ctxLoading = new Map(); // cmi → último {pct, phase, conv} enquanto lê a fila JS
function _restoreMediaCtx(cmi, conv, pct, phase) {
  const busy = _ctxLoading.has(cmi);
  _ctxLoading.set(cmi, { pct, phase, conv });
  if (busy) return;
  (async () => {
    let p = null;
    try { const s = await require('./messageOutbox').getStatus(cmi); p = (s && s.payload) || null; } catch {}
    const last = _ctxLoading.get(cmi);
    _ctxLoading.delete(cmi);
    if (!last) return;
    const pp = p ? { ...p, client_message_id: cmi, conversation_id: p.conversation_id ?? last.conv }
      : (last.conv != null ? { conversation_id: last.conv, client_message_id: cmi } : null);
    if (!pp) return;
    if (p && !_mediaCtx.has(cmi)) _mediaCtx.set(cmi, { p: pp });
    try { require('./mediaSendQueue').emitProgressExternal?.(pp, cmi, last.pct, last.phase); } catch {}
  })().catch(() => { _ctxLoading.delete(cmi); });
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

/** [conectando 2026-10-20] Acorda a fila nativa (fim de ligação, reconexão). */
export function kickNative(reason = 'js') {
  const m = _resolve();
  if (!m) return false;
  try { configureNativeOutbox(); m.outboxKick(String(reason || 'js')); return true; } catch { return false; }
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
  _watch.clear(); _rescued.clear();
  const m = _resolve();
  try { m?.outboxForget?.(); } catch {}
}

export default {
  nativeOutboxEnabled, nativeOutboxStats, isNativeOwned, configureNativeOutbox,
  canTakeText, canTakeMedia, sendTextNow, sendRowAndWait, handoffUpload,
  reconcile, migratePending, bootNativeOutbox, forgetNativeOutbox, isNativeRescued, kickNative,
};
