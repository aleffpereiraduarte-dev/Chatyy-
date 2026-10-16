// services/leafSeq.js — [2026-10-16 multi-região fase 4] cliente do sequenciador
// regional (leaf com casa por conversa: /root/multi-regiao/DESIGN.md §3/§5).
//
// O leaf-casa dá o ✓ ANTES do apply no master: o chat_send_ack traz a linha com
// o id definitivo (Snowflake) mas SEM conv_pts (`hub: "leaf-<região>-seq"`). Depois
// do apply chega a CÓPIA CANÔNICA (chat_message no chat_user_<eu>, com conv_pts).
// Três desfechos tratados aqui (o resto do envio não muda):
//   1. applied/late → cópia canônica com conv_pts → o outbox esquece a mensagem
//      (regionalAccept: linha 'accepted' até lá = RPO ≈ 0; reenvio com o MESMO
//      cmi se a cópia não vier — o servidor deduplica);
//   2. tombstone (re-gate no master: saiu do grupo / DM bloqueada) → o leaf manda
//      `delete {reason:'leaf_tombstone'}` + `chat_send_rejected {reason:'regate'}`.
//      Para o REMETENTE a bolha NÃO some nem vira "apagada": vira "Mensagem não
//      enviada" (vermelha, Tentar/Apagar). O registro persiste (o servidor guarda
//      a linha apagada com o mesmo cmi → recarregar não pode ressuscitar "apagada").
//      Tentar de novo usa cmi NOVO (o antigo deduplicaria na linha apagada).
//   3. dup_other (o mesmo cmi já existia com outro id) → `delete {reason:
//      'leaf_dup_other', dup_of}` → vira `chat_message_remap {from_id,to_id}`:
//      a bolha troca de id (ou some, se a canônica já está na tela). Nunca duplica.
// Kill switch (OTA): globalThis.__chatyy_leaf_seq_client = false → os eventos
// do leaf voltam ao tratamento genérico de antes (delete = apagada).
import { Platform } from 'react-native';

const STORE_KEY = 'chatyy_leaf_rejected_v1';
const MAX_ENTRIES = 300;
const TTL_MS = 30 * 24 * 3600 * 1000;

const _byId = new Map();  // String(id) → entry
const _byCmi = new Map(); // cmi → entry
const _subs = new Set();
let _version = 0;
let _loaded = false;
let _saveTm = null;

export function enabled() {
  try { if (globalThis.__chatyy_leaf_seq_client === false) return false; } catch {}
  return true;
}

// e-mails legados @onemundo.com.br == @chatyy.com.br (o servidor reescreve)
function _canon(e) { return String(e || '').trim().toLowerCase().replace(/@onemundo\.com\.br$/, '@chatyy.com.br'); }

function _numId(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  if (typeof v === 'string' && /^\d{1,19}$/.test(v)) { const n = Number(v); return n > 0 ? n : 0; }
  return 0;
}

/**
 * Linha aceita pela casa regional e ainda NÃO aplicada no master (sem conv_pts).
 * `hub` = campo do chat_send_ack (quando o caminho o expõe). Sem hub (fila
 * nativa só repassa a linha): linha completa (RETURNING * tem conv_pts e
 * sync_seq) sem a chave conv_pts = cópia local do journal do leaf.
 */
export function isPreApplyRow(row, hub) {
  if (!row || typeof row !== 'object' || !_numId(row.id)) return false;
  if (Number(row.conv_pts) > 0) return false;
  if (typeof hub === 'string' && /-seq$/.test(hub)) return true;
  return Object.prototype.hasOwnProperty.call(row, 'sync_seq') && !Object.prototype.hasOwnProperty.call(row, 'conv_pts');
}

// ── registro de envios rejeitados (re-gate) ────────────────────────────────
function _storage() {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}
function _load() {
  if (_loaded) return;
  _loaded = true;
  const AS = _storage();
  if (!AS) return;
  try {
    AS.getItem(STORE_KEY).then((raw) => {
      if (!raw) return;
      let arr = null;
      try { arr = JSON.parse(raw); } catch { arr = null; }
      if (!Array.isArray(arr)) return;
      const now = Date.now();
      let n = 0;
      for (const e of arr) {
        if (!e || now - (Number(e.at) || 0) > TTL_MS) continue;
        if (e.id && _byId.has(String(e.id))) continue;
        if (e.cmi && _byCmi.has(String(e.cmi))) continue;
        _index(e); n++;
      }
      if (n) _bump();
    }).catch(() => {});
  } catch {}
}
function _index(e) {
  if (e.id) _byId.set(String(e.id), e);
  if (e.cmi) _byCmi.set(String(e.cmi), e);
}
function _all() {
  const seen = new Set();
  const out = [];
  for (const m of [_byId, _byCmi]) for (const e of m.values()) { if (!seen.has(e)) { seen.add(e); out.push(e); } }
  return out;
}
function _save() {
  if (_saveTm) return;
  _saveTm = setTimeout(() => {
    _saveTm = null;
    const AS = _storage();
    if (!AS) return;
    try {
      let arr = _all().sort((a, b) => (a.at || 0) - (b.at || 0));
      if (arr.length > MAX_ENTRIES) {
        for (const e of arr.slice(0, arr.length - MAX_ENTRIES)) {
          if (e.id) _byId.delete(String(e.id));
          if (e.cmi) _byCmi.delete(String(e.cmi));
        }
        arr = arr.slice(-MAX_ENTRIES);
      }
      AS.setItem(STORE_KEY, JSON.stringify(arr)).catch(() => {});
    } catch {}
  }, 300);
}
function _bump() {
  _version++;
  for (const fn of Array.from(_subs)) { try { fn(_version); } catch {} }
}

export function version() { _load(); return _version; }
export function subscribe(fn) {
  _load();
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

export function getRejected(idOrMsg) {
  _load();
  if (!_byId.size && !_byCmi.size) return null;
  if (idOrMsg && typeof idOrMsg === 'object') {
    const m = idOrMsg;
    return (m.id != null && _byId.get(String(m.id)))
      || (m._client_id && _byCmi.get(String(m._client_id)))
      || (m.client_message_id && _byCmi.get(String(m.client_message_id)))
      || null;
  }
  if (idOrMsg == null) return null;
  return _byId.get(String(idOrMsg)) || _byCmi.get(String(idOrMsg)) || null;
}
export function isRejected(idOrMsg) { const e = getRejected(idOrMsg); return !!(e && !e.hidden); }

/** Re-gate no master: marca o envio como "não enviado" (idempotente; funde id + cmi). */
export function markRejected(info) {
  if (!info) return null;
  _load();
  const id = _numId(info.id) || 0;
  const cmi = info.client_message_id ? String(info.client_message_id) : (info.cmi ? String(info.cmi) : '');
  if (!id && !cmi) return null;
  let e = (id && _byId.get(String(id))) || (cmi && _byCmi.get(cmi)) || null;
  const fresh = !e;
  if (!e) e = { id: 0, cmi: '', conv: null, content: '', type: '', reason: '', at: Date.now(), hidden: false };
  if (id && !e.id) e.id = id;
  if (cmi && !e.cmi) e.cmi = cmi;
  if (info.conversation_id != null && e.conv == null) e.conv = String(info.conversation_id);
  if (info.content && !e.content) e.content = String(info.content).slice(0, 4000);
  if (info.type && !e.type) e.type = String(info.type);
  if (info.reason && !e.reason) e.reason = String(info.reason);
  _index(e);
  // conteúdo p/ redesenhar depois de recarregar (o servidor guarda a linha apagada)
  if (!e.content && e.cmi && Platform.OS !== 'web') {
    try {
      Promise.resolve(require('./messageOutbox').getStatus?.(e.cmi)).then((s) => {
        const p = s && s.payload;
        if (p && !e.content && (p.display_content || p.content)) {
          e.content = String(p.display_content || p.content).slice(0, 4000);
          if (!e.type && p.type) e.type = String(p.type);
          _save(); _bump();
        }
      }).catch(() => {});
    } catch {}
  }
  _save();
  if (fresh || id || cmi) _bump();
  return e;
}

/** Usuário apagou a bolha "não enviada" (ou reenviou com cmi novo): some da conversa. */
export function hideRejected(msg) {
  const e = getRejected(msg);
  if (!e) return false;
  e.hidden = true;
  e.content = '';
  _save(); _bump();
  return true;
}

/**
 * Lista da conversa (ordem qualquer) → bolhas próprias rejeitadas viram
 * "não enviada" (nunca "apagada"); escondidas saem. Sem registro = mesma lista.
 * `ver` (= version()/subscribe) é ignorado aqui: o chamador passa a versão do
 * registro como ARGUMENTO p/ o React Compiler a pôr nas dependências do memo
 * (`void ver;` some na compilação — expressão sem efeito).
 */
export function applyRejected(list, me, ver) {
  if (!enabled() || !Array.isArray(list) || (!_byId.size && !_byCmi.size)) return list;
  const self = _canon(me);
  let changed = false;
  const out = [];
  for (const m of list) {
    if (!m || m._type) { out.push(m); continue; }
    const e = getRejected(m);
    if (!e) { out.push(m); continue; }
    const own = m._self || !m.sender_email || (self && _canon(m.sender_email) === self);
    if (!own) { out.push(m); continue; }
    changed = true;
    if (e.hidden) continue;
    // reenvio em curso (Tentar): mantém o relógio; falhou de novo → volta ao vermelho
    const retrying = m._pending === true && m._failed !== true;
    out.push({
      ...m,
      content: m.content || e.content || '',
      type: m.type || e.type || 'text',
      deleted_at: null, deleted: false, deleted_by: null, deleted_for_everyone: false,
      _failed: !retrying, _pending: retrying, _queued: retrying ? !!m._queued : false,
      _leafRejected: true,
      _client_id: m._client_id || e.cmi || undefined,
      _sendError: 'chat_send_rejected:' + (e.reason || 'regate'),
    });
  }
  return changed ? out : list;
}

// ── eventos do leaf no socket (websocket._handleMessage) ───────────────────
/**
 * `delete` vindo do leaf. true = consumido (não seguir p/ o tratamento genérico).
 * emit(ev, data) = websocket._emit.
 */
export function interceptDelete(d, selfEmail, emit) {
  if (!enabled() || !d || typeof d !== 'object') return false;
  const reason = String(d.reason || '');
  if (reason !== 'leaf_dup_other' && reason !== 'leaf_tombstone') return false;
  const id = _numId(d.id);
  const conv = d.conversation_id;
  if (!id || conv == null) return false;
  if (reason === 'leaf_dup_other') {
    const to = _numId(d.dup_of);
    if (!to || to === id) return false;
    const ev = { conversation_id: conv, from_id: id, to_id: to, sender_email: d.sender_email || '' };
    onRemap(ev);
    try { emit('chat_message_remap', ev); } catch {}
    return true;
  }
  const self = _canon(selfEmail);
  const sender = _canon(d.sender_email);
  if (!self || sender !== self) return false; // par: apagada normal (DESIGN §3.5)
  markRejected({ id, conversation_id: conv, reason: 'regate' });
  try { emit('chat_send_rejected', { conversation_id: conv, id, reason: 'regate', error: 'regate', _leaf: true }); } catch {}
  return true;
}

/** dup_other: o id local some do cache (a canônica já existe com to_id). */
export function onRemap(ev) {
  if (!ev) return;
  const conv = ev.conversation_id;
  const from = _numId(ev.from_id);
  const to = _numId(ev.to_id);
  if (!from || !to || conv == null) return;
  try { require('./regionalAccept').noteRemap?.(from, to); } catch {}
  try { require('./chatCache').deleteCachedMessage?.(conv, from)?.catch?.(() => {}); } catch {}
  // registro de rejeição apontando p/ o id velho → passa p/ o novo
  const e = _byId.get(String(from));
  if (e) { _byId.delete(String(from)); e.id = to; _index(e); _save(); _bump(); }
}

/**
 * Remapeia uma lista de mensagens (estado da tela). Sem efeito = mesma lista.
 * Se a canônica (to_id) já está na lista, a cópia local sai; senão troca o id.
 */
export function remapList(list, ev) {
  if (!Array.isArray(list) || !ev) return list;
  const from = String(ev.from_id);
  const to = _numId(ev.to_id);
  if (!to) return list;
  let hasTo = false; let hasFrom = false;
  for (const m of list) {
    if (!m) continue;
    const k = String(m.id);
    if (k === String(to)) hasTo = true;
    else if (k === from) hasFrom = true;
  }
  if (!hasFrom) return list;
  if (hasTo) return list.filter(m => !m || String(m.id) !== from);
  return list.map(m => (m && String(m.id) === from) ? { ...m, id: to } : m);
}

/** Cópia canônica que o socket descartaria por id repetido (ver websocket.js). */
export function isCanonicalCopy(inner) {
  return !!(inner && _numId(inner.id) && Number(inner.conv_pts) > 0);
}

export default {
  enabled, isPreApplyRow, markRejected, hideRejected, getRejected, isRejected,
  applyRejected, interceptDelete, onRemap, remapList, isCanonicalCopy, subscribe, version,
};
