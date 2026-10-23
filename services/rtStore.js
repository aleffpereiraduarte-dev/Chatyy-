// [sgu F1/F2 2026-10-23] Corpo das conversas "body_store" (sem gravar no US) — lado do APP, parte local.
// Plano /root/sem-gravar-no-us-2026-10-22/PLANO.md §5.2 "App" · contrato do app: …/app/CONTRATO-APP.md.
//
// Na F2 o servidor devolve, para mensagem E2EE v5 de conversa body_store ≥ 2, só um ESQUELETO:
//   { id, conversation_id, sender_*, created_at, type, …, content: null, body: "local" }   (ou body_loc: "rt")
// O corpo (envelope cifrado) mora no aparelho (SQLite / IndexedDB) e na fila do roteador até o ack.
// Este módulo:
//   1. GUARDA dos escritores locais (db.dbSaveMessages, sqliteStore.upsertMessagesSync, webSaveMessages):
//      esqueleto NUNCA pisa no envelope que o aparelho já tem; esqueleto sem cópia local não vira linha.
//   2. HIDRATA as respostas de leitura (api.apiCall): esqueleto → envelope local; o que falta vai ao
//      roteador (rtInbox.pullMids); o que o roteador também não tem vira "Mensagem indisponível neste aparelho".
//   3. Guarda as conversas conhecidas como body_store (chat_list.body_store) — só elas ligam o resto.
// Conversa sem a flag: nada muda (o caminho rápido sai no 1º teste).
// Kill OTA:
//   globalThis.__chatyy_rt_hydrate = false   → não hidrata nem mostra "indisponível" (a GUARDA continua: ela só
//                                               impede apagar o corpo local, nunca mostra nada)
//   globalThis.__chatyy_rt_guard   = false   → desliga até a guarda (volta ao INSERT OR REPLACE cego)
//   globalThis.__chatyy_rt_inbox   = false   → sem rt_pull (rtInbox.js)

import { Platform } from 'react-native';

const isWeb = Platform.OS === 'web';
const CONVS_KEY = 'chatyy_rt_convs_v1';
export const RT_READ_ACTIONS = new Set(['chat_messages', 'chat_load_around', 'chat_messages_by_date', 'chat_sync', 'chat_ws_events', 'chat_list', 'chat_message_get', 'chat_get_message']);

function _flag(name) { try { return globalThis[name]; } catch { return undefined; } }
export function guardOn() { return _flag('__chatyy_rt_guard') !== false; }
export function hydrateOn() { return _flag('__chatyy_rt_hydrate') !== false; }

export function isEnvelope(s) { return typeof s === 'string' && s.startsWith('{"e2e":5'); }

/** Linha-esqueleto do servidor (corpo fora do PG) ainda sem envelope. */
export function isSkeleton(m) {
  if (!m || typeof m !== 'object') return false;
  if (!(m.body === 'local' || m.body_loc === 'rt' || m._rtMissing || m._rtPending)) return false;
  return !isEnvelope(m.content);
}
function _isTomb(m) { return !!(m && (m.deleted || m.deleted_at || m.deleted_for_all || m.is_deleted)); }

// ─── conversas body_store conhecidas ─────────────────────────────────────────
let _convs = null; // Map cid → body_store (1..3)
let _convsDirty = false;
const _listeners = new Set();
function _loadConvs() {
  if (_convs) return;
  _convs = new Map();
  try {
    const raw = require('./mmkv').getString(CONVS_KEY);
    const j = raw ? JSON.parse(raw) : null;
    if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) { const n = Number(v); if (n >= 1 && n <= 3) _convs.set(String(k), n); }
  } catch {}
}
function _saveConvs() {
  if (!_convsDirty) return;
  _convsDirty = false;
  try { require('./mmkv').setString(CONVS_KEY, JSON.stringify(Object.fromEntries(_convs))); } catch {}
}
/** body_store da conversa (0 = desconhecida/sem). */
export function convBodyStore(cid) { _loadConvs(); return _convs.get(String(cid)) || 0; }
export function hasRtConvs() { _loadConvs(); return _convs.size > 0; }
export function rtConvIds() { _loadConvs(); return [..._convs.keys()]; }
export function onRtConvsChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
/** Registra (ou tira) o body_store de uma conversa. Monotônico no servidor; aqui segue o que vier. */
export function noteConvBodyStore(cid, bs) {
  if (cid == null) return;
  _loadConvs();
  const k = String(cid); const n = Number(bs) || 0;
  const prev = _convs.get(k) || 0;
  if (n === prev) return;
  if (n >= 1 && n <= 3) _convs.set(k, n); else _convs.delete(k);
  _convsDirty = true; _saveConvs();
  for (const fn of _listeners) { try { fn(k, n, prev); } catch {} }
}

// ─── leitura do envelope local ──────────────────────────────────────────────
/** Nativo, síncrono: Map(id → envelope) das linhas locais com envelope. */
export function localEnvelopesSync(ids) {
  const out = new Map();
  if (isWeb || !ids || !ids.length) return out;
  try {
    const db = require('./sqliteStore').getSyncDb();
    if (!db) return out;
    const nums = [...new Set(ids.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
    for (let i = 0; i < nums.length; i += 400) {
      const part = nums.slice(i, i + 400);
      const rows = db.getAllSync(`SELECT id, content FROM messages WHERE id IN (${part.map(() => '?').join(',')})`, part) || [];
      for (const r of rows) if (isEnvelope(r.content)) out.set(String(r.id), r.content);
    }
  } catch {}
  return out;
}
async function _localEnvelopes(ids) {
  if (!isWeb) return localEnvelopesSync(ids);
  try { return await require('./localDb').webGetEnvelopesByIds(ids); } catch { return new Map(); }
}

// ─── GUARDA dos escritores ──────────────────────────────────────────────────
/**
 * Nativo (síncrono): devolve as linhas que podem ser gravadas. Esqueleto com envelope local → leva o envelope;
 * esqueleto sem cópia local → sai do lote (nunca vira linha vazia/placeholder no SQLite). Lápide passa como está.
 * Caminho rápido: lote sem esqueleto volta o MESMO array.
 */
export function guardRowsSync(convId, messages) {
  try {
    if (!guardOn() || !Array.isArray(messages) || !messages.length) return messages;
    let any = false;
    for (const m of messages) if (isSkeleton(m) && !_isTomb(m)) { any = true; break; }
    if (!any) return messages;
    const ids = messages.filter((m) => isSkeleton(m) && !_isTomb(m)).map((m) => m.id);
    const local = localEnvelopesSync(ids);
    return _applyGuard(messages, local);
  } catch { return messages; }
}
/** Web: o mesmo, com leitura do IndexedDB. */
export async function guardRows(convId, messages) {
  try {
    if (!guardOn() || !Array.isArray(messages) || !messages.length) return messages;
    if (!messages.some((m) => isSkeleton(m) && !_isTomb(m))) return messages;
    const local = await _localEnvelopes(messages.filter((m) => isSkeleton(m) && !_isTomb(m)).map((m) => m.id));
    return _applyGuard(messages, local);
  } catch { return messages; }
}
function _clean(m) {
  const o = { ...m };
  delete o._rtMissing; delete o._rtPending; delete o._e5Hidden; delete o._e2eFailed; delete o._e5State;
  return o;
}
function _applyGuard(messages, local) {
  const out = [];
  for (const m of messages) {
    if (!isSkeleton(m) || _isTomb(m)) { out.push(m); continue; }
    const env = local.get(String(m.id));
    if (env) { const o = _clean(m); o.content = env; out.push(o); }
    // sem cópia local: fora do lote (o rt_pull grava quando o corpo chegar)
  }
  return out;
}

// ─── HIDRATAÇÃO das respostas ───────────────────────────────────────────────
function _tr(key, fb) {
  try {
    const { lookupKey } = require('../i18n');
    const lang = (require('./api').getAuthHeaders?.() || {})['X-User-Language'] || 'pt-BR';
    const s = lookupKey ? lookupKey(lang, key) : null;
    return typeof s === 'string' && s ? s : fb;
  } catch { return fb; }
}
export function unavailableText() {
  return _tr('sgu.msg.unavailable', 'Mensagem indisponível neste aparelho. Restaure o backup em Ajustes > Conversas > Backup.');
}

// coleta esqueletos e conversas com body_store em qualquer lugar da resposta (profundidade/volume limitados)
function _walk(node, depth, acc) {
  if (!node || typeof node !== 'object' || depth > 5 || acc.n > 8000) return;
  acc.n++;
  if (Array.isArray(node)) { for (const x of node) _walk(x, depth + 1, acc); return; }
  if (node.body_store != null && (node.id != null || node.conversation_id != null) && (node.type === 'direct' || node.type === 'group' || 'members' in node || 'last_message' in node || 'unread_count' in node)) {
    acc.convs.push([node.id != null ? node.id : node.conversation_id, node.body_store]);
  }
  if (node.id != null && isSkeleton(node) && !_isTomb(node)) acc.rows.push(node);
  for (const k in node) {
    const v = node[k];
    if (v && typeof v === 'object') _walk(v, depth + 1, acc);
  }
}

let _stats = { hydrated: 0, pulled: 0, unavailable: 0, pending: 0 };
export function getRtStoreStats() { return { ..._stats, convs: (_loadConvs(), _convs.size) }; }

function _markUnavailable(m) {
  m.content = unavailableText();
  m.type = 'text';
  m._rtMissing = 1; m._e2e = true; m._e2eFailed = true; m._e5State = 'rt_unavailable';
  delete m._rtPending; delete m._e5Hidden;
}

/**
 * Pós-processa a resposta de uma leitura (muta as linhas in place; devolve a mesma resposta).
 * Nunca lança. Sem esqueleto e sem body_store → custo de uma varredura rasa.
 */
export async function hydrateResponse(action, params, resp) {
  try {
    if (!resp || typeof resp !== 'object' || !RT_READ_ACTIONS.has(action)) return resp;
    const acc = { rows: [], convs: [], n: 0 };
    _walk(resp, 0, acc);
    for (const [cid, bs] of acc.convs) noteConvBodyStore(cid, bs);
    if (acc.rows.length || hasRtConvs()) { try { require('./rtInbox').ensureStarted(); } catch {} }
    if (!acc.rows.length) return resp;
    for (const m of acc.rows) { const cid = m.conversation_id != null ? m.conversation_id : params?.conversation_id; if (cid != null && !convBodyStore(cid)) noteConvBodyStore(cid, 2); }
    if (!hydrateOn()) return resp;
    const local = await _localEnvelopes(acc.rows.map((m) => m.id));
    const missing = [];
    for (const m of acc.rows) {
      const env = local.get(String(m.id));
      if (env) { m.content = env; delete m._rtPending; delete m._rtMissing; _stats.hydrated++; } else missing.push(m);
    }
    if (!missing.length) return resp;
    // falta no aparelho → pede ao roteador por mid (espera curta; o resto chega por envelope_available)
    let res = null;
    try { res = await require('./rtInbox').pullMids(missing.map((m) => ({ id: m.id, conversation_id: m.conversation_id != null ? m.conversation_id : params?.conversation_id })), { waitMs: 1800, why: action }); } catch { res = null; }
    const got = (res && res.envelopes) || new Map();
    const gone = (res && res.gone) || new Set();
    for (const m of missing) {
      const env = got.get(String(m.id));
      if (env) { m.content = env; delete m._rtPending; _stats.pulled++; continue; }
      if (gone.has(String(m.id))) { _markUnavailable(m); _stats.unavailable++; try { require('./rtInbox').noteUnavailableShown(res && res.why ? res.why : 'gone'); } catch {} continue; }
      // ainda chegando (rede/timeout): fora da lista até o corpo chegar (nunca balão vazio)
      m.content = ''; m._rtPending = 1; m._e5Hidden = true; _stats.pending++;
    }
  } catch {}
  return resp;
}

/**
 * Frame WS (chat_message/chat_summary/replay) com esqueleto: síncrono. Linha com envelope local → recebe o envelope
 * já; sem cópia → fica fora da lista (_e5Hidden) e o corpo é pedido ao roteador (chega por envelope_available).
 * Frame sem esqueleto: custo de um teste. Kill: __chatyy_rt_hydrate=false.
 */
export function hydrateWsFrameSync(msg) {
  try {
    if (!msg || typeof msg !== 'object' || !hydrateOn()) return;
    const t = msg.type;
    if (t !== 'chat_message' && t !== 'chat_summary' && t !== 'chat_edit' && t !== 'message_edited') return;
    const d = msg.data && typeof msg.data === 'object' ? msg.data : msg;
    const m = d.message && typeof d.message === 'object' ? d.message : d;
    if (!m || m.id == null || !isSkeleton(m) || _isTomb(m)) return;
    const cid = m.conversation_id != null ? m.conversation_id : d.conversation_id;
    if (cid != null && !convBodyStore(cid)) noteConvBodyStore(cid, 2);
    const env = localEnvelopesSync([m.id]).get(String(m.id));
    if (env) { m.content = env; return; }
    m.content = ''; m._rtPending = 1; m._e5Hidden = true;
    try { require('./rtInbox').pullMids([{ id: m.id, conversation_id: cid }], { waitMs: 0, why: 'ws' }).catch(() => {}); } catch {}
  } catch {}
}
