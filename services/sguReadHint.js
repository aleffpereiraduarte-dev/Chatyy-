// [sgu F0 2026-10-23] Dica do POR QUÊ este aparelho pede mensagens ao servidor — só para o contador
// `sgu_body_reads` do servidor (quantas vezes um corpo E2EE saiu do PG; plano /root/sem-gravar-no-us-2026-10-22
// PLANO.md §3.1). Vai em 2 cabeçalhos pequenos (X-Chatyy-Sgu = motivo, X-E2EE-Device = aparelho e2ee5) nas ações de
// leitura de mensagens. Não muda o pedido nem a resposta; servidor sem o kit ignora.
//   web             navegador (não guarda histórico)
//   aparelho_novo   aparelho com < 48 h neste app e SEM nada local da conversa (instalou/reinstalou)
//   sem_cache_local sem nenhuma linha local da conversa (aparelho já em uso)
//   rolagem         paginando para trás (before_id/offset) ou por data
//   sync            chat_sync / chat_ws_events (catch-up)
//   abrir           abrir a conversa com cache local (o resto)
// Kill OTA: globalThis.__chatyy_sgu_read_hint = false.

import { Platform } from 'react-native';

const FIRST_KEY = 'chatyy_sgu_first_seen_v1';
const NEW_MS = 48 * 3600 * 1000;
export const SGU_READ_ACTIONS = new Set(['chat_messages', 'chat_load_around', 'chat_messages_by_date', 'chat_sync', 'chat_ws_events']);
let _first = 0;

function _firstSeen() {
  if (_first) return _first;
  try {
    const mm = require('./mmkv');
    const v = Number(mm.getString(FIRST_KEY) || 0);
    if (v > 0) { _first = v; return v; }
    _first = Date.now();
    mm.setString(FIRST_KEY, String(_first));
  } catch { _first = Date.now(); }
  return _first;
}

function _hasLocal(cid) {
  try {
    const st = require('./sqliteStore');
    if (typeof st.isReady === 'function' && !st.isReady()) return true; // store ainda abrindo → não chuta "sem cache"
    return Number(st.getLastMessageIdSync?.(cid) || 0) > 0;
  } catch { return true; }
}

/** Motivo da leitura (string curta). Nunca lança. */
export function sguReadWhy(action, params) {
  try {
    if (Platform.OS === 'web') return 'web';
    if (action === 'chat_sync' || action === 'chat_ws_events') return 'sync';
    const p = params || {};
    if (action === 'chat_messages_by_date') return 'rolagem';
    const cid = Number(p.conversation_id || 0);
    if (cid > 0 && !_hasLocal(cid)) return (Date.now() - _firstSeen() < NEW_MS) ? 'aparelho_novo' : 'sem_cache_local';
    if (p.before_id || p.before || p.offset || p.cursor) return 'rolagem';
    return 'abrir';
  } catch { return ''; }
}

/** Cabeçalhos para apiCall (ou null). */
export function sguReadHeaders(action, params) {
  try {
    if (globalThis.__chatyy_sgu_read_hint === false || !SGU_READ_ACTIONS.has(action)) return null;
    const h = {};
    const why = sguReadWhy(action, params);
    if (why) h['X-Chatyy-Sgu'] = why;
    let d = '';
    try { d = require('./dlvDevice').dlvDeviceIdSync() || ''; } catch {}
    if (d) h['X-E2EE-Device'] = d;
    return Object.keys(h).length ? h : null;
  } catch { return null; }
}

// marca a 1ª vez cedo (boot), para "aparelho_novo" valer desde a instalação
try { setTimeout(() => { try { _firstSeen(); } catch {} }, 0); } catch {}
