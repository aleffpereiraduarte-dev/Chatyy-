// services/nativeChatStore.js — [2026-10-15 native-store]
//
// Gate do store local NATIVO (modules/expo-chat-store, SQLite do sistema, um
// arquivo por conta). Fase 1: a lista nativa da conversa (ChatyyMessageList,
// apiVersion ≥ 4) lê a "foto" da última janela que mostrou e pinta SEM esperar
// o JS; depois de cada applyRows regrava a foto sozinha (nada cruza a ponte).
// O JS só manda {conta, conversa, rev, chave mais nova}. Desenho completo e
// próximas fases: docs/native-store-DESIGN.md.
//
// Kill switch (OTA): globalThis.__chatyy_native_store = false
// Nunca lança. Web → tudo desligado.
import { Platform } from 'react-native';

const NATIVE_STORE_DEFAULT_ON = true;

let _mod; // undefined = não resolvido; null = indisponível

function _resolve() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return _mod;
  try {
    const expo = require('expo');
    const m = typeof expo.requireOptionalNativeModule === 'function'
      ? expo.requireOptionalNativeModule('ChatyyChatStore')
      : null;
    if (m && typeof m.apiVersion === 'function' && Number(m.apiVersion()) >= 1) _mod = m;
  } catch { _mod = null; }
  return _mod;
}

/** Kill switch + binário com o módulo. */
export function nativeStoreEnabled() {
  try {
    const o = globalThis.__chatyy_native_store;
    if (o === false) return false;
    if (o !== true && !NATIVE_STORE_DEFAULT_ON) return false;
  } catch {}
  return !!_resolve();
}

/** FNV-1a 32 bits → hex (assinatura do formato das linhas). */
export function fnv(str) {
  let h = 0x811c9dc5;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/** Dia local AAAA-MM-DD — entra no rev: rótulos "Hoje/Ontem" da foto valem só no dia. */
export function localDay(d = new Date()) {
  try {
    const p = (n) => (n < 10 ? '0' : '') + n;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  } catch { return ''; }
}

/**
 * Chave da mensagem mais nova da foto salva ('' = sem foto). Síncrono (lookup
 * por PK na fila do store; ~0,1 ms). Usado só p/ decidir montar a lista nativa
 * quando o JS ainda não tem linhas (cache JS frio).
 */
export function threadNewestSync(account, conv) {
  if (!nativeStoreEnabled() || !account || conv == null) return '';
  try { return String(_mod.threadNewestSync(String(account).trim().toLowerCase(), String(conv)) || ''); } catch { return ''; }
}

export function nativeStoreStats(account) {
  if (!_resolve() || !account) return null;
  try { return _mod.statsSync(String(account).trim().toLowerCase()); } catch { return null; }
}

/**
 * P0 PRIVACY: apaga TODAS as fotos (todas as contas) — logout / troca de conta
 * (chamado por AuthContext.clearLocalChatStore junto do chatyy.db). Ignora o
 * kill switch de propósito: limpeza sempre roda se o binário tiver o módulo.
 */
export async function wipeNativeStore() {
  // lote pendente da conta que está saindo NÃO pode recriar o arquivo dela
  try { if (_flushTm) clearTimeout(_flushTm); } catch {}
  _flushTm = null; _pend = null;
  try { require('./nativeStoreRows').resetNativeStoreRows(); } catch {}
  const m = _resolve();
  if (!m || typeof m.wipeAll !== 'function') return true;
  try { await m.wipeAll(); return true; } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════
// [2026-10-15 native-store fase 1.5 / 2] — apiVersion ≥ 2 do módulo nativo.
// ═══════════════════════════════════════════════════════════════════════════

/** apiVersion do store nativo (0 = indisponível / desligado). */
export function nativeStoreApi() {
  if (!nativeStoreEnabled()) return 0;
  try { return Number(_mod.apiVersion()) || 0; } catch { return 0; }
}

function _acct(a) { return String(a || '').trim().toLowerCase(); }

/**
 * [fase 1.5] pressIn da linha da home: a foto da conversa é lida e decodificada
 * em memória no nativo; quando a tela abre, a lista nativa pinta SÍNCRONA no set
 * da prop (sem hop de fila). Fire-and-forget, ~µs no JS.
 */
export function prewarmThread(account, conv) {
  if (nativeStoreApi() < 2 || !account || conv == null) return;
  try { _mod.prewarmThread(_acct(account), String(conv)); } catch {}
}

/** [fase 1.5] { rev, top } da foto da home ('' quando não há). Síncrono (PK). */
export function homeTopSync(account, scope = 'main') {
  if (nativeStoreApi() < 2 || !account) return null;
  try {
    const s = String(_mod.homeTopSync(_acct(account), String(scope)) || '');
    if (!s) return null;
    const i = s.indexOf('\n');
    return i < 0 ? { rev: s, top: '' } : { rev: s.slice(0, i), top: s.slice(i + 1) };
  } catch { return null; }
}

/** [fase 2] mensagens canônicas do store nativo (raw do servidor), antiga→nova. */
export function nativeMessagesSync(account, conv, limit = 50, beforeId = 0) {
  if (nativeStoreApi() < 2 || !account || conv == null) return [];
  try {
    const arr = JSON.parse(String(_mod.messagesSync(_acct(account), String(conv), Number(beforeId) || 0, Number(limit) || 50) || '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

// ─── [fase 2] escrita dupla em lote ─────────────────────────────────────────
// O sync atual continua dono da lógica e do chatyy.db; aqui cada gravação de
// mensagens/conversas (services/db.js) também vai, COALESCIDA, para o store
// nativo — 1 string JSON por lote (~150 ms), aplicada numa transação na fila do
// store. Junto, services/nativeStoreRows monta FORA DA TELA as linhas das
// mensagens novas das conversas FECHADAS e manda operações na "foto" → abrir a
// conversa pinta já com o que chegou (some o "stale" da fase 1).

const FLUSH_MS = 150;
const MAX_PER_CONV = 200;
let _pend = null; // { acct, convs: Map, msgs: Map<conv, Map<id, m>>, dels: [] }
let _flushTm = null;
let _batchStats = { batches: 0, msgs: 0, threadOps: 0, errors: 0, lastMs: 0 };

export function nativeStoreBatchStats() { return { ..._batchStats }; }

function _ms(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v > 1e12 ? Math.round(v) : Math.round(v * 1000);
  let s = String(v).trim().replace(' ', 'T');
  if (!(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s))) {
    const m = s.match(/([+-]\d{2})$/);
    s = m ? s.slice(0, -m[0].length) + m[0] + ':00' : s + 'Z';
  }
  const n = Date.parse(s);
  return Number.isFinite(n) ? n : 0;
}

function _activeAccount() {
  try { return _acct(require('./chatStore').getActiveAccount()); } catch { return ''; }
}

function _pending(acct) {
  if (_pend && _pend.acct !== acct) _flushNow(); // conta trocou: lote anterior sai sozinho
  if (!_pend) _pend = { acct, convs: new Map(), msgs: new Map(), dels: [] };
  if (!_flushTm) _flushTm = setTimeout(_flushNow, FLUSH_MS);
  return _pend;
}

function _numId(id) {
  const n = typeof id === 'number' ? id : (/^\d+$/.test(String(id || '')) ? Number(id) : NaN);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Espelha mensagens gravadas no chatyy.db (chamado por services/db.js
 * dbSaveMessages / sqliteStore.upsertMessagesSync). Nunca lança; web = no-op.
 */
export function mirrorMessages(convId, messages) {
  if (convId == null || !Array.isArray(messages) || !messages.length) return;
  if (nativeStoreApi() < 2) return;
  const acct = _activeAccount();
  if (!acct) return;
  try {
    const p = _pending(acct);
    const cid = String(convId);
    let m = p.msgs.get(cid);
    if (!m) { m = new Map(); p.msgs.set(cid, m); }
    for (const msg of messages) {
      if (!msg) continue;
      const id = _numId(msg.id);
      if (!id) continue; // tmp_/otimista: só o servidor confirma
      if (msg.account_email && _acct(msg.account_email) !== acct) continue;
      m.set(id, msg);
    }
  } catch {}
}

/** Espelha conversas (services/db.js dbSaveConversations). */
export function mirrorConversations(convs) {
  if (!Array.isArray(convs) || !convs.length || nativeStoreApi() < 2) return;
  const acct = _activeAccount();
  if (!acct) return;
  try {
    const p = _pending(acct);
    for (const c of convs) {
      if (!c || c.id == null) continue;
      if (c.account_email && _acct(c.account_email) !== acct) continue;
      p.convs.set(String(c.id), c);
    }
  } catch {}
}

/** Remoção física (expurgo) — services/db.js dbDeleteMessage. */
export function mirrorDeleteMessage(convId, messageId) {
  const id = _numId(messageId);
  if (convId == null || !id || nativeStoreApi() < 2) return;
  const acct = _activeAccount();
  if (!acct) return;
  try {
    const p = _pending(acct);
    p.dels.push({ conv: String(convId), id });
    const m = p.msgs.get(String(convId));
    if (m) m.delete(id);
  } catch {}
}

function _msgEntry(cid, id, m) {
  let raw = '';
  try { raw = JSON.stringify(m); } catch { return null; }
  const cl = m._client_id || m.client_message_id || m.client_temp_id || '';
  return {
    conv: cid, id,
    ckey: cl ? `c:${cl}` : String(id),
    client_id: String(cl || ''),
    sender: String(m.sender_email || m.sender || '').toLowerCase(),
    type: String(m.type || 'text'),
    created_at: _ms(m.created_at),
    edited_at: _ms(m.edited_at),
    deleted: (m.deleted_at || m.deleted) ? 1 : 0,
    reply_to: _numId(m.reply_to_id || (m.reply_to && m.reply_to.id)) || 0,
    raw,
  };
}

function _convEntry(c) {
  const lm = c.last_message && typeof c.last_message === 'object' ? c.last_message : null;
  let raw = '';
  try { raw = JSON.stringify(c); } catch { return null; }
  return {
    id: String(c.id),
    type: String(c.type || 'direct'),
    name: String(c.display_name || c.name || ''),
    avatar: String(c.avatar_url || c.avatar || ''),
    last_msg_id: _numId(lm && lm.id),
    last_ts: _ms(c.last_message_at || (lm && lm.created_at) || c.updated_at),
    unread: Number(c.unread_count) || 0,
    pinned: c.pinned ? 1 : 0,
    muted: c.muted ? 1 : 0,
    archived: c.archived ? 1 : 0,
    pts: Number(c.pts) || 0,
    read_watermark: Number(c.last_read_message_id) || 0,
    raw,
  };
}

function _flushNow() {
  if (_flushTm) { clearTimeout(_flushTm); _flushTm = null; }
  const p = _pend;
  _pend = null;
  if (!p || nativeStoreApi() < 2) return;
  const t0 = Date.now();
  try {
    const batch = { v: 1 };
    const convs = [];
    for (const c of p.convs.values()) { const e = _convEntry(c); if (e) convs.push(e); }
    if (convs.length) batch.conversations = convs;
    const msgs = []; const receipts = []; const reactions = []; const threads = [];
    for (const [cid, map] of p.msgs) {
      const list = Array.from(map.entries()).sort((a, b) => a[0] - b[0]).slice(-MAX_PER_CONV);
      for (const [id, m] of list) {
        const e = _msgEntry(cid, id, m);
        if (!e) continue;
        msgs.push(e);
        const dl = _ms(m.delivered_at); const rd = _ms(m.read_at);
        if (dl || rd) receipts.push({ conv: cid, msg_id: id, delivered_at: dl, read_at: rd });
        if (Array.isArray(m.reactions)) {
          const set = [];
          for (const r of m.reactions) {
            const emoji = r && (r.emoji || r.reaction);
            if (!emoji) continue;
            const users = typeof r.users === 'string' ? r.users.split(',').filter(Boolean) : (Array.isArray(r.users) ? r.users : []);
            set.push({ emoji: String(emoji), users: users.map(u => String(u || '').toLowerCase()) });
          }
          reactions.push({ conv: cid, msg_id: id, set });
        }
      }
      // [fase 2] linhas montadas FORA da tela → operações na foto (conversa fechada)
      try {
        const ops = require('./nativeStoreRows').threadOpsFor(p.acct, cid, list.map(x => x[1]));
        if (ops) threads.push(ops);
      } catch {}
    }
    if (msgs.length) batch.messages = msgs;
    if (p.dels.length) batch.msg_deletes = p.dels;
    if (receipts.length) batch.receipts = receipts;
    if (reactions.length) batch.reactions = reactions;
    if (threads.length) batch.threads = threads;
    if (!convs.length && !msgs.length && !p.dels.length && !threads.length) return;
    const json = JSON.stringify(batch);
    _batchStats.batches++; _batchStats.msgs += msgs.length; _batchStats.threadOps += threads.length;
    _batchStats.lastMs = Date.now() - t0;
    const pr = _mod.applyBatchAsync(p.acct, json);
    if (pr && typeof pr.then === 'function') {
      pr.then((r) => { if (!r || !r.ok) _batchStats.errors++; }, () => { _batchStats.errors++; });
    }
  } catch { _batchStats.errors++; }
}

/** Força o envio do lote pendente (testes / antes de sair do app). */
export function flushNativeStoreBatch() { _flushNow(); }

/**
 * [2b] Formato do lote para quem grava fora do JS (expo-chat-transport):
 * ver ChatyyStoreDB.applyBatch (Swift/Kotlin) — mesmas chaves deste arquivo.
 */
export const NATIVE_STORE_BATCH_KEYS = ['conversations', 'conv_deletes', 'messages', 'msg_deletes', 'receipts', 'reactions', 'cursors', 'threads'];
