// [2026-10-10 regional-accept-client] Cliente do "aceite regional" do chat_send.
//
// Com REGIONAL_ACCEPT=on no edge (BR/EU), /var/www/mail/api/regional-accept.php
// responde o chat_send de texto com uma linha PROVISÓRIA (`data.id = tmp_…`,
// `_regional_accepted: true`) gravada no spool durável do edge, e drena p/ o US
// (autoridade: id numérico, conv_pts, created_at). Daí:
//   • o id numérico chega depois — eco WS do próprio envio (chat_message /
//     chat_summary com client_message_id) ou uma re-tentativa com o MESMO
//     client_message_id (o edge devolve a linha 'done'; o US deduplica);
//   • se o US rejeitar em definitivo (4xx), o edge manda o evento WS
//     `chat_send_rejected` {conversation_id, client_message_id, temp_id, http,
//     error} → bolha "não enviada" com tocar-p/-tentar.
//
// Este módulo:
//   1. mantém a linha do outbox em 'accepted' (messageOutbox.markSent com id
//      tmp_ → markAccepted) até o id numérico chegar — a mensagem NÃO sai do
//      outbox só porque o edge aceitou;
//   2. confirma (markSent numérico) ao ver o eco do próprio envio;
//   3. re-dirige ('accepted' → 'queued') o que ficar sem confirmação >45 s —
//      o worker reenvia com o mesmo client_message_id (idempotente no edge e
//      no US), cobrindo eco perdido / app morto;
//   4. no `chat_send_rejected`: outbox → 'failed' (hard) e marca o cmi p/ que a
//      re-tentativa do usuário vá DIRETO ao US (`regional_off: 1` no corpo;
//      sem isso o edge repetiria a rejeição guardada no spool por até 6 h).
// Flag desligada no servidor = nada disto dispara (respostas normais têm id
// numérico). Web: sem outbox SQLite — só a parte de rejeição/bypass vale.
import { Platform } from 'react-native';

const REDRIVE_AFTER_MS = 45000;
const SWEEP_EVERY_MS = 30000;
const BYPASS_TTL_MS = 7 * 3600 * 1000; // > 6 h de retenção do spool
const BYPASS_MAX = 200;
const BYPASS_KEY = 'chatyy_ra_bypass_v1';

const _pending = new Map(); // cmi -> { conversationId, tempId, at }
const _bypass = new Map();  // cmi -> ts
let _installed = false;
let _sweepTimer = null;
let _bypassLoaded = false;

function _outbox() {
  try { return require('./messageOutbox'); } catch { return null; }
}
function _ws() {
  try { return require('./websocket').default; } catch { return null; }
}

export function isNumericId(id) {
  if (typeof id === 'number') return Number.isFinite(id) && id > 0;
  return typeof id === 'string' && /^\d{1,19}$/.test(id) && id !== '0';
}

/** Id provisório do aceite regional (edge) — nunca é um id de servidor. */
export function isProvisionalId(id) {
  return typeof id === 'string' && /^tmp_/.test(id);
}

/** Resposta de chat_send aceita pelo edge mas ainda não gravada no US. */
export function isRegionalProvisional(r) {
  const d = r && r.data;
  if (!d || r.envelope_mode) return false;
  if (d._regional_accepted === true) return true;
  return isProvisionalId(d.id);
}

// ── bypass (re-tentativa depois de rejeição → direto ao US) ───────────────
function _bypassSave() {
  try {
    const AS = require('@react-native-async-storage/async-storage').default;
    const obj = {};
    for (const [k, v] of _bypass) obj[k] = v;
    AS.setItem(BYPASS_KEY, JSON.stringify(obj)).catch(() => {});
  } catch {}
}
function _bypassLoad() {
  if (_bypassLoaded) return;
  _bypassLoaded = true;
  try {
    const AS = require('@react-native-async-storage/async-storage').default;
    AS.getItem(BYPASS_KEY).then((raw) => {
      if (!raw) return;
      let obj = null;
      try { obj = JSON.parse(raw); } catch { obj = null; }
      if (!obj || typeof obj !== 'object') return;
      const now = Date.now();
      for (const k of Object.keys(obj)) {
        const ts = Number(obj[k]) || 0;
        if (now - ts < BYPASS_TTL_MS && !_bypass.has(k)) _bypass.set(k, ts);
      }
    }).catch(() => {});
  } catch {}
}
function _bypassAdd(cmi) {
  if (!cmi) return;
  const now = Date.now();
  _bypass.set(String(cmi), now);
  for (const [k, ts] of _bypass) { if (now - ts > BYPASS_TTL_MS) _bypass.delete(k); }
  while (_bypass.size > BYPASS_MAX) { const first = _bypass.keys().next().value; _bypass.delete(first); }
  _bypassSave();
}

/** api.chatSend: este cmi foi rejeitado no edge → pedir caminho direto. */
export function shouldBypassRegional(cmi) {
  _bypassLoad();
  if (!cmi) return false;
  const ts = _bypass.get(String(cmi));
  if (!ts) return false;
  if (Date.now() - ts > BYPASS_TTL_MS) { _bypass.delete(String(cmi)); return false; }
  return true;
}

// ── aceito / confirmado / rejeitado ───────────────────────────────────────
/** api.chatSend chama ao receber a linha provisória do edge. */
export function noteAccepted(cmi, info = {}) {
  if (!cmi) return;
  install();
  const k = String(cmi);
  const prev = _pending.get(k);
  _pending.set(k, {
    conversationId: info.conversationId != null ? info.conversationId : prev?.conversationId,
    tempId: info.tempId || prev?.tempId || null,
    at: Date.now(),
  });
  _armSweep();
}

function _confirm(cmi, id) {
  const k = String(cmi);
  if (!_pending.has(k)) return;
  _pending.delete(k);
  const ob = _outbox();
  try { ob?.markSent?.(k, Number(id))?.catch?.(() => {}); } catch {}
}

function _onOwnMessage(payload) {
  if (!_pending.size || !payload) return;
  const inner = payload.message || payload;
  const cmi = inner && (inner.client_message_id || payload.client_message_id);
  const id = inner && inner.id;
  if (!cmi || !isNumericId(id)) return;
  _confirm(cmi, id);
}

function _onAck(msg) {
  if (!_pending.size || !msg) return;
  const cmi = msg.client_message_id;
  const id = msg.msg_id != null ? msg.msg_id : (msg.server_id != null ? msg.server_id : msg.message_id);
  if (cmi && isNumericId(id)) _confirm(cmi, id);
}

/** Também chamado pela tela do chat (web não instala o worker). Idempotente. */
export function noteRejected(data) { _onRejected(data); }

function _onRejected(data) {
  const cmi = data && data.client_message_id ? String(data.client_message_id) : '';
  if (!cmi) return;
  _pending.delete(cmi);
  _bypassAdd(cmi);
  const err = String((data && data.error) || 'rejected').slice(0, 200);
  const ob = _outbox();
  try {
    ob?.markFailed?.(cmi, new Error('chat_send_rejected:' + err), { kind: 'hard' })?.catch?.(() => {});
  } catch {}
  try { console.warn('[regionalAccept] chat_send_rejected', { conv: data && data.conversation_id, http: data && data.http, err }); } catch {}
}

// ── re-dirigir o que ficou sem confirmação ───────────────────────────────
async function _sweep() {
  _sweepTimer = null;
  const ob = _outbox();
  const now = Date.now();
  try {
    // Linhas 'accepted' persistidas (inclui as de uma sessão anterior do app).
    const rows = (await ob?.listAccepted?.()) || [];
    for (const r of rows) {
      const k = String(r.client_message_id);
      if (!_pending.has(k)) _pending.set(k, { conversationId: r.conversation_id, tempId: r.payload?.temp_id || null, at: Number(r.updated_at) || now });
    }
    const due = [];
    for (const [k, v] of _pending) {
      if (now - (v.at || 0) >= REDRIVE_AFTER_MS) due.push(k);
    }
    for (const k of due) {
      const ok = await ob?.redriveAccepted?.(k);
      // Sem linha 'accepted' (web / já confirmada / já falhou) → esquece.
      if (!ok) _pending.delete(k);
      else _pending.set(k, { ..._pending.get(k), at: Date.now() });
    }
    if (due.length) { try { require('./sendWorker').poke?.(); } catch {} }
  } catch {}
  _armSweep();
}

function _armSweep() {
  if (_sweepTimer || !_pending.size) return;
  _sweepTimer = setTimeout(() => { _sweep().catch(() => {}); }, SWEEP_EVERY_MS);
}

/** Idempotente. sendWorker.start() chama no boot (recupera 'accepted' antigos). */
export function install() {
  if (_installed) return;
  _installed = true;
  _bypassLoad();
  const ws = _ws();
  if (ws && typeof ws.on === 'function') {
    try { ws.on('chat_send_rejected', _onRejected); } catch {}
    try { ws.on('chat_message', _onOwnMessage); } catch {}
    try { ws.on('chat_summary', _onOwnMessage); } catch {}
    try { ws.on('message_ack', _onAck); } catch {}
  }
  if (Platform.OS !== 'web') {
    // Boot: linhas 'accepted' de uma sessão anterior entram na varredura.
    setTimeout(() => {
      const ob = _outbox();
      Promise.resolve(ob?.listAccepted?.()).then((rows) => {
        if (!Array.isArray(rows) || !rows.length) return;
        for (const r of rows) {
          const k = String(r.client_message_id);
          if (!_pending.has(k)) _pending.set(k, { conversationId: r.conversation_id, tempId: r.payload?.temp_id || null, at: Number(r.updated_at) || Date.now() });
        }
        _armSweep();
      }).catch(() => {});
    }, 2000);
  }
}

export default {
  isNumericId,
  isProvisionalId,
  isRegionalProvisional,
  shouldBypassRegional,
  noteAccepted,
  noteRejected,
  install,
};
