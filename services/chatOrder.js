// services/chatOrder.js — [import-ordem 2026-10-13] ordem cronológica real da
// conversa quando ela tem histórico importado do WhatsApp intercalado.
//
// O chat sempre ordenou por id (sequência global do servidor). Histórico
// importado DEPOIS ganha id maior mas data antiga → cairia no fim. Nas conversas
// "por data" (com importação), a ordem passa a ser (data em segundos, id):
//   • data = created_at normalizado p/ UTC 'YYYY-MM-DD HH:MM:SS' (o servidor
//     grava sort_ts = date_trunc('second', created_at), então servidor, SQLite
//     local e tela concordam exatamente; empate → id);
//   • linhas sem id numérico (otimistas tmp_, envelope) seguem a regra antiga
//     (sempre no fim, por _negId) — nada muda para o que está sendo enviado.
// Conversas SEM importação continuam 100% por id (zero mudança de comportamento).
//
// A marca "conversa por data" vem do servidor (chat_messages → wa_import_rev),
// do evento history_imported, ou de linhas importadas (client_message_id 'wai:').
// Fica no MMKV (síncrono) para a 1ª pintura da próxima abertura já sair certa.

const STORE_KEY = 'chat_time_order_convs_v1';
const MAX_CONVS = 1000;

let _set = null;          // Set<string> de conversation ids
const _revs = new Map();  // conv → último wa_import_rev visto NESTA sessão (memória)

function _mmkv() {
  try { return require('./mmkv'); } catch { return null; }
}

function _load() {
  if (_set) return _set;
  _set = new Set();
  try {
    const arr = _mmkv()?.getJSON?.(STORE_KEY);
    if (Array.isArray(arr)) for (const id of arr) { if (id != null && id !== '') _set.add(String(id)); }
  } catch {}
  return _set;
}

function _save() {
  try {
    let arr = Array.from(_load());
    if (arr.length > MAX_CONVS) arr = arr.slice(arr.length - MAX_CONVS);
    _mmkv()?.setJSON?.(STORE_KEY, arr);
  } catch {}
}

export function isImportedMsg(m) {
  if (!m) return false;
  const c = m.client_message_id;
  return typeof c === 'string' && c.startsWith('wai:');
}

/** A conversa usa ordem por data? */
export function isTimeOrdered(convId) {
  if (convId == null || convId === '') return false;
  try { return _load().has(String(convId)); } catch { return false; }
}

/** Marca a conversa como "por data" (idempotente). */
export function markTimeOrdered(convId) {
  if (convId == null || convId === '') return;
  const s = _load();
  const k = String(convId);
  if (s.has(k)) return;
  s.add(k);
  _save();
}

/**
 * Registra o wa_import_rev que o servidor mandou. Devolve true quando MUDOU
 * nesta sessão (1ª vez também) → a tela deve recarregar a janela inteira.
 */
export function noteImportRev(convId, rev) {
  if (convId == null || !rev) return false;
  markTimeOrdered(convId);
  const k = String(convId);
  const r = String(rev);
  if (_revs.get(k) === r) return false;
  _revs.set(k, r);
  return true;
}

/** Esquece o rev desta sessão (evento history_imported → força recarga). */
export function forgetImportRev(convId) {
  if (convId == null) return;
  _revs.delete(String(convId));
}

/** Modo por data: conversa marcada OU algum item importado na lista. */
export function timeModeFor(convId, rows) {
  if (isTimeOrdered(convId)) return true;
  if (Array.isArray(rows)) {
    for (let i = 0; i < rows.length; i++) { if (isImportedMsg(rows[i])) return true; }
  }
  return false;
}

// ── chave de ordenação ──────────────────────────────────────────────────────
const _keyCache = new WeakMap();
const _ISO = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?\s*(Z|[+-]\d\d(?::?\d\d)?)?$/i;
const _pad = (n) => (n < 10 ? '0' : '') + n;

/** created_at → 'YYYY-MM-DD HH:MM:SS' (UTC, segundos) ou '' quando ilegível. */
export function sortKeyOf(createdAt) {
  if (createdAt == null || createdAt === '') return '';
  if (typeof createdAt === 'number' || /^\d{10,13}$/.test(String(createdAt))) {
    let n = Number(createdAt);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1e12) n *= 1000;
    return _fmt(new Date(n));
  }
  const s = String(createdAt).trim();
  const m = _ISO.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? _fmt(new Date(t)) : '';
  }
  const tz = m[7];
  if (!tz || tz === 'Z' || tz === 'z' || /^[+-]00(:?00)?$/.test(tz)) {
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`;
  }
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${tz.length === 3 ? tz + ':00' : tz}`);
  return Number.isFinite(t) ? _fmt(new Date(t)) : '';
}

function _fmt(d) {
  return `${d.getUTCFullYear()}-${_pad(d.getUTCMonth() + 1)}-${_pad(d.getUTCDate())} ${_pad(d.getUTCHours())}:${_pad(d.getUTCMinutes())}:${_pad(d.getUTCSeconds())}`;
}

function _key(m) {
  if (!m || typeof m !== 'object') return '';
  let k = _keyCache.get(m);
  if (k === undefined) {
    k = sortKeyOf(m.sort_ts || m.created_at);
    try { _keyCache.set(m, k); } catch {}
  }
  return k;
}

/**
 * [2026-10-13 vídeo-sumiu] Chave de ordem "por id" de QUALQUER linha.
 * id numérico → id. Linha local (tmp_/envelope/outbox) → _negId (Date.now()*1000,
 * sempre > qualquer id do servidor = fica no FIM). Sem _negId (bolha de
 * foto/vídeo/arquivo e bolhas reidratadas do outbox não tinham) → derivada do
 * created_at; ilegível → fim. ANTES caía em 0 = a bolha pendente ia para o
 * TOPO do histórico a cada reordenação (recarga de janela, msg fora de ordem,
 * conversa por data) — "mandei um vídeo e ele SUMIU" (conv 973, 13/10).
 */
export function orderKey(m) {
  if (!m || typeof m !== 'object') return Number.MAX_SAFE_INTEGER;
  if (typeof m.id === 'number') return m.id;
  const n = Number(m._negId);
  if (Number.isFinite(n) && n > 0) return n;
  const t = m.created_at ? Date.parse(m.created_at) : NaN;
  if (Number.isFinite(t) && t > 0) return t * 1000;
  return Number.MAX_SAFE_INTEGER;
}

/** Comparador "por id" (conversas sem importação) que nunca joga pendentes p/ o topo. */
export function compareById(a, b) {
  const ai = orderKey(a);
  const bi = orderKey(b);
  if (ai !== bi) return ai < bi ? -1 : 1;
  const ta = a && a.created_at ? Date.parse(a.created_at) : 0;
  const tb = b && b.created_at ? Date.parse(b.created_at) : 0;
  const td = (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  if (td !== 0) return td;
  const ak = String((a && (a._client_id || a.temp_id || a.id)) || '');
  const bk = String((b && (b._client_id || b.temp_id || b.id)) || '');
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

/**
 * Comparador da conversa "por data". Linhas com id numérico: (data, id).
 * Demais (tmp_/envelope): regra antiga — id numérico vs _negId, depois created_at.
 */
export function compareMsgs(a, b) {
  const an = a && typeof a.id === 'number';
  const bn = b && typeof b.id === 'number';
  if (an && bn) {
    const ka = _key(a);
    const kb = _key(b);
    if (ka && kb && ka !== kb) return ka < kb ? -1 : 1;
    return a.id - b.id;
  }
  const ai = orderKey(a);
  const bi = orderKey(b);
  if (ai !== bi) return ai < bi ? -1 : 1;
  const ta = a && a.created_at ? Date.parse(a.created_at) : 0;
  const tb = b && b.created_at ? Date.parse(b.created_at) : 0;
  const td = (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  if (td !== 0) return td;
  const ak = String((a && (a._client_id || a.temp_id || a.id)) || '');
  const bk = String((b && (b._client_id || b.temp_id || b.id)) || '');
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

/** Ordena uma cópia por data (só use em conversa por data). */
export function sortByTime(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  return rows.slice().sort(compareMsgs);
}

/** Expressão SQLite equivalente a sortKeyOf p/ created_at em UTC ('Z' / '+00'). */
export const SQL_SORT_EXPR = "substr(replace(created_at, 'T', ' '), 1, 19)";

/** Linha local ainda não confirmada pelo servidor (bolha otimista/outbox). */
export function isLocalPending(m) {
  if (!m || typeof m.id === 'number') return false;
  if (typeof m.id === 'string' && m.id.startsWith('tmp_')) return true;
  return !!(m._pending || m._uploading || m._queued || m._failed);
}

/**
 * [2026-10-13 vídeo-sumiu] Garante que nenhuma recarga/substituição de janela
 * remove bolhas locais pendentes: toda linha de `prev` que é pendente
 * (isLocalPending), não está em `next` (por id) e cuja confirmação do servidor
 * (mesmo client_message_id) NÃO veio em `next` volta para a lista. Mantém a
 * mesma referência quando nada precisa voltar.
 */
export function keepLocalPending(prev, next) {
  if (!Array.isArray(prev) || !prev.length || !Array.isArray(next)) return next;
  let missing = null;
  let ids = null;
  let cids = null;
  for (const m of prev) {
    if (!isLocalPending(m)) continue;
    if (!ids) {
      ids = new Set();
      cids = new Set();
      for (const n of next) {
        if (!n) continue;
        if (n.id != null) ids.add(String(n.id));
        const c = n._client_id || n.client_message_id;
        if (c) cids.add(String(c));
      }
    }
    if (ids.has(String(m.id))) continue;
    const c = m._client_id || m.client_message_id;
    if (c && cids.has(String(c))) continue;
    (missing || (missing = [])).push(m);
  }
  if (!missing) return next;
  return [...next, ...missing];
}

export default {
  isImportedMsg, isTimeOrdered, markTimeOrdered, noteImportRev, forgetImportRev,
  timeModeFor, sortKeyOf, compareMsgs, compareById, orderKey, sortByTime, SQL_SORT_EXPR,
  isLocalPending, keepLocalPending,
};
