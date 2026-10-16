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
//
// [2026-10-16 multi-região fase 4] Casa regional (leaf-seq): o ✓ vem com o id
// DEFINITIVO mas antes do apply no master (linha sem conv_pts — leafSeq.
// isPreApplyRow). Mesmo tratamento do id tmp_: a linha fica 'accepted' (agora
// com server_id) até a CÓPIA CANÔNICA (conv_pts > 0) chegar; sem ela em ~45 s,
// reenvio com o MESMO cmi (o leaf/US deduplicam e devolvem a linha). RPO ≈ 0
// enquanto o aparelho do remetente existir (DESIGN §6). dup_other → confirma com
// o id real (noteRemap); tombstone → chat_send_rejected (abaixo).
import { Platform } from 'react-native';

const REDRIVE_AFTER_MS = 45000;
const SWEEP_EVERY_MS = 30000;
const BYPASS_TTL_MS = 7 * 3600 * 1000; // > 6 h de retenção do spool
const BYPASS_MAX = 200;
const BYPASS_KEY = 'chatyy_ra_bypass_v1';
// [fase 4] teto de reenvios de uma linha 'accepted' do leaf-seq sem cópia
// canônica (≈ 30 min em partição longa); depois a linha vira 'sent' (o journal
// do edge segue drenando sozinho — só o seguro extra do cliente expira).
const SEQ_MAX_REDRIVES = 40;

const _pending = new Map(); // cmi -> { conversationId, tempId, at, kind?:'seq', id?, n? }
const _seqIds = new Map();  // String(id) -> cmi (kind 'seq')
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

// ── [fase 4] casa regional: ✓ antes do apply ──────────────────────────────
/** api.chatSend / nativeOutbox: ✓ do leaf-seq (id final, sem conv_pts). */
export function noteLocalSeq(cmi, info = {}) {
  if (!cmi) return;
  try { if (globalThis.__chatyy_leaf_seq_client === false) return; } catch {}
  install();
  const k = String(cmi);
  const prev = _pending.get(k);
  const id = info.id != null ? String(info.id) : (prev && prev.id) || '';
  _pending.set(k, {
    conversationId: info.conversationId != null ? info.conversationId : prev?.conversationId,
    tempId: info.tempId || prev?.tempId || null,
    at: Date.now(),
    kind: 'seq',
    id,
    n: prev && prev.kind === 'seq' ? (prev.n || 0) : 0,
  });
  if (id) _seqIds.set(id, k);
  _armSweep();
}

/** Resposta canônica (com conv_pts) do mesmo cmi: nada a esperar. */
export function noteCanonical(cmi) {
  if (!cmi) return;
  const k = String(cmi);
  const v = _pending.get(k);
  if (!v || v.kind !== 'seq') return;
  _pending.delete(k);
  if (v.id) _seqIds.delete(String(v.id));
}

/** messageOutbox.markSent: esta linha ainda espera a cópia canônica? */
export function isAwaitingCanonical(cmi) {
  if (!cmi) return false;
  const v = _pending.get(String(cmi));
  return !!(v && v.kind === 'seq');
}

/** dup_other: o cmi já existia no master com outro id → confirma com o real. */
export function noteRemap(fromId, toId) {
  const cmi = _seqIds.get(String(fromId));
  if (!cmi) return;
  _seqIds.delete(String(fromId));
  _confirm(cmi, toId);
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
  const v = _pending.get(k);
  if (!v) return;
  _pending.delete(k);
  if (v.id) _seqIds.delete(String(v.id));
  const ob = _outbox();
  try { ob?.markSent?.(k, Number(id))?.catch?.(() => {}); } catch {}
}

function _onOwnMessage(payload) {
  if (!_pending.size || !payload) return;
  const inner = payload.message || payload;
  let cmi = inner && (inner.client_message_id || payload.client_message_id);
  const id = inner && inner.id;
  if (!isNumericId(id)) return;
  if (!cmi) cmi = _seqIds.get(String(id)) || '';
  if (!cmi) return;
  const v = _pending.get(String(cmi));
  if (!v) return;
  // [fase 4] leaf-seq: só a cópia CANÔNICA (conv_pts) confirma — o eco local
  // (sendWorker/_publish) e a cópia rápida do leaf vêm sem pts.
  if (v.kind === 'seq' && !(Number(inner.conv_pts) > 0)) return;
  _confirm(cmi, id);
}

function _onAck(msg) {
  if (!_pending.size || !msg) return;
  const cmi = msg.client_message_id;
  const id = msg.msg_id != null ? msg.msg_id : (msg.server_id != null ? msg.server_id : msg.message_id);
  if (cmi && _pending.get(String(cmi))?.kind === 'seq') return; // ack ≠ apply
  if (cmi && isNumericId(id)) _confirm(cmi, id);
}

/** Também chamado pela tela do chat (web não instala o worker). Idempotente. */
export function noteRejected(data) { _onRejected(data); }

function _onRejected(data) {
  let cmi = data && data.client_message_id ? String(data.client_message_id) : '';
  // [fase 4] tombstone do leaf: o `delete` (sem cmi) chega antes do evento com cmi
  if (!cmi && data && data.id != null) cmi = _seqIds.get(String(data.id)) || '';
  if (data && (data.reason === 'regate' || data._leaf)) {
    try { require('./leafSeq').markRejected?.({ ...data, client_message_id: cmi || data.client_message_id }); } catch {}
  }
  if (!cmi) return;
  const pv = _pending.get(cmi);
  _pending.delete(cmi);
  if (pv && pv.id) _seqIds.delete(String(pv.id));
  if (data && data.id != null) _seqIds.delete(String(data.id));
  _bypassAdd(cmi);
  const err = String((data && (data.error || data.reason)) || 'rejected').slice(0, 200);
  const ob = _outbox();
  try {
    ob?.markFailed?.(cmi, new Error('chat_send_rejected:' + err), { kind: 'hard', force: !!(data && (data.reason === 'regate' || data._leaf)) })?.catch?.(() => {});
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
      if (!_pending.has(k)) _pending.set(k, _entryFromRow(r, now));
    }
    const due = [];
    for (const [k, v] of _pending) {
      if (now - (v.at || 0) >= REDRIVE_AFTER_MS) due.push(k);
    }
    for (const k of due) {
      const v = _pending.get(k) || {};
      if (v.kind === 'seq' && (v.n || 0) >= SEQ_MAX_REDRIVES) {
        // teto: para de segurar (markSent normal — a entrada sai antes)
        _pending.delete(k);
        if (v.id) _seqIds.delete(String(v.id));
        try { await ob?.markSent?.(k, v.id ? Number(v.id) : null); } catch {}
        continue;
      }
      const ok = await ob?.redriveAccepted?.(k);
      if (!ok && v.kind === 'seq') {
        // reenvio ainda na fila do worker (offline / backoff): segue vigiando
        // (sem zerar a contagem do teto)
        let st = null;
        try { st = await ob?.getStatus?.(k); } catch {}
        if (st && (st.state === 'queued' || st.state === 'sending')) { _pending.set(k, { ...v, at: Date.now() }); continue; }
      }
      // Sem linha 'accepted' (web / já confirmada / já falhou) → esquece.
      if (!ok) { _pending.delete(k); if (v.id) _seqIds.delete(String(v.id)); }
      else _pending.set(k, { ...v, at: Date.now(), n: (v.n || 0) + 1 });
    }
    if (due.length) { try { require('./sendWorker').poke?.(); } catch {} }
  } catch {}
  _armSweep();
}

// Linha 'accepted' persistida → entrada (server_id numérico = leaf-seq).
function _entryFromRow(r, now) {
  const sid = r && r.server_id;
  if (isNumericId(sid)) {
    _seqIds.set(String(sid), String(r.client_message_id));
    return { conversationId: r.conversation_id, tempId: r.payload?.temp_id || null, at: Number(r.updated_at) || now, kind: 'seq', id: String(sid), n: 0 };
  }
  return { conversationId: r.conversation_id, tempId: r.payload?.temp_id || null, at: Number(r.updated_at) || now };
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
    // [fase 4] cópia canônica que o socket descartou por id repetido (websocket.js)
    try { ws.on('chat_message_canonical', _onOwnMessage); } catch {}
  }
  if (Platform.OS !== 'web') {
    // Boot: linhas 'accepted' de uma sessão anterior entram na varredura.
    setTimeout(() => {
      const ob = _outbox();
      Promise.resolve(ob?.listAccepted?.()).then((rows) => {
        if (!Array.isArray(rows) || !rows.length) return;
        for (const r of rows) {
          const k = String(r.client_message_id);
          if (!_pending.has(k)) _pending.set(k, _entryFromRow(r, Date.now()));
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
  noteLocalSeq,
  noteCanonical,
  isAwaitingCanonical,
  noteRemap,
  install,
};
