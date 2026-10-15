// services/nativeStoreRows.js — [2026-10-15 native-store fase 2]
//
// Linhas da lista nativa montadas FORA DA TELA, para a "foto" da conversa no
// store nativo (modules/expo-chat-store) nunca ficar velha.
//
// Problema da fase 1: chegou mensagem com a conversa FECHADA → a foto gravada
// pela lista nativa ficou para trás → ao abrir, a chave mais nova da foto não
// bate com a do JS → foto ignorada (caminho JS de antes).
//
// Agora: enquanto a conversa esteve aberta nesta sessão, a própria
// <ChatyyMessageList> registra aqui o "ambiente" de montagem (o MESMO ctx do
// buildRow da tela, o rev do formato, a função de chave e a última linha que a
// foto tem). Quando o sync grava mensagens dessa conversa já FECHADA
// (services/db.js → nativeChatStore.mirrorMessages → lote), este módulo monta as
// linhas novas com o buildRow REAL (components/chat/nativeThreadList) e devolve
// operações para a foto (append/set/put/stUpTo/drop — ver ChatyyStoreDB
// applyThreadOps). A conversa aberta nunca é tocada (a lista grava sozinha).
//
// Regras conservadoras (na dúvida, NÃO mexe ou apaga a foto → caminho atual):
//   • só mensagens com id > última da foto viram append; álbum/tipo não
//     suportado pela lista nativa → drop (a tela decide sozinha ao abrir);
//   • editada/apagada/reação em mensagem já na foto → put (mantém agrupamento
//     e recibo da linha que a tela montou);
//   • recibo de leitura/entrega das minhas → stUpTo (só sobe ✓).
// Limite conhecido: conversa que NÃO abriu nesta sessão (sem ambiente) segue
// como na fase 1 (foto ignorada se ficou velha). Kill switch: o do store
// (globalThis.__chatyy_native_store = false).

const MAX_ENVS = 12;
const _envs = new Map(); // conv → env (ordem = LRU)
const _mounted = new Map(); // conv → nº de listas montadas
let _stats = { appended: 0, put: 0, dropped: 0, receipts: 0, skippedNoEnv: 0 };

export function nativeStoreRowsStats() { return { ..._stats, envs: _envs.size }; }

export function resetNativeStoreRows() { _envs.clear(); _mounted.clear(); _profSent.clear(); _profCleared = false; }

function _iso(dateStr) {
  if (!dateStr) return '';
  let s = String(dateStr).trim().replace(' ', 'T');
  if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  const bare = s.match(/([+-]\d{2})$/);
  if (bare) return s.slice(0, -bare[0].length) + bare[0] + ':00';
  return s + 'Z';
}
function _ts(v) { const n = Date.parse(_iso(v)); return Number.isFinite(n) ? n : NaN; }
function _dayKey(v) {
  const t = _ts(v);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function _isTmp(id) { return typeof id === 'string' && id.startsWith('tmp'); }
function _num(id) { const n = typeof id === 'number' ? id : (/^\d+$/.test(String(id || '')) ? Number(id) : NaN); return Number.isFinite(n) ? n : 0; }
const MEDIA = new Set(['image', 'video', 'gif']);

/** Mesma regra do msgKeyExtractor da tela (app/chat-conversation.js). */
export function defaultKeyOf(item) {
  if (item._key) return item._key;
  const persistent = item._client_id || item.client_message_id;
  if (persistent) return item.deleted_at ? `c:${persistent}_d` : `c:${persistent}`;
  return item.deleted_at ? `${item.id}_d` : String(item.id);
}

/** Linha mais nova que a foto guarda (mesmo filtro do persistNow nativo). */
export function tailOf(data, keyOf) {
  if (!Array.isArray(data)) return null;
  for (let i = data.length - 1; i >= 0; i--) {
    const it = data[i];
    if (!it || it._type === 'unread_separator' || _isTmp(it.id)) continue;
    if (it._type === 'separator') return null; // separador por último = estado estranho → sem tail
    let k;
    try { k = keyOf ? keyOf(it) : defaultKeyOf(it); } catch { return null; }
    const last = it._type === 'album' && Array.isArray(it._items) && it._items.length ? it._items[it._items.length - 1] : it;
    return {
      k,
      id: _num(it._type === 'album' ? last.id : it.id),
      sender: String(it.sender_email || '').toLowerCase(),
      ts: _ts(it.created_at),
      type: it._type === 'album' ? 'album' : String(it.type || 'text'),
      day: _dayKey(it.created_at),
      batch: (last && (last._batch_id || last.batch_id)) || null,
    };
  }
  return null;
}

/**
 * Chamado pela <ChatyyMessageList> (nativeThreadList.js) a cada mudança de
 * dados/ctx e ao desmontar. env = { acct, rev, ctx, keyOf, data }.
 * Guarda só referências (barato); o tail é calculado na hora do uso.
 */
export function registerThreadEnv(conv, env) {
  if (conv == null || !env || !env.acct || !env.rev || !env.ctx) return;
  const k = String(conv);
  _envs.delete(k);
  _envs.set(k, { acct: String(env.acct).toLowerCase(), rev: env.rev, ctx: env.ctx, keyOf: env.keyOf, data: env.data, tail: undefined });
  while (_envs.size > MAX_ENVS) _envs.delete(_envs.keys().next().value);
  _pushTextProfile(k, env);
}

// ─── [2026-10-15 fase 2b] RowBuilder NATIVO de texto simples ────────────────
// Com o JS ocupado/no fundo, o transporte nativo grava a mensagem nova no store
// e — SÓ para texto simples numa conversa 1:1 — já monta a linha da foto no
// nativo (StoreIngest.textOps / ChatyyStoreIngest.textOps), com este "perfil"
// tirado do ctx REAL da tela: formato de hora, rótulo "Hoje", conta, rev da foto
// e as regras de texto (allow/deny: nada de marcação, link, @, #, números,
// palavras que viram lembrete/reunião). Quando o JS processa a mesma mensagem, a
// linha "oficial" (buildRow) substitui a nativa no lugar. Fora do perfil → a foto
// fica marcada como desatualizada (threadStaleSync) e o JS remonta ao abrir.
// Flag (OTA): globalThis.__chatyy_native_text_rows === true liga (padrão DESLIGADO).
const TEXT_ALLOW = "^[A-Za-zÀ-ÖØ-öø-ÿ ,.!?'()-]{1,500}$";
const TEXT_DENY = 'hoje|amanh|ontem|manh|tarde|noite|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|semana|reuni|meet|encontro|call|liga[cç]|videocham|today|tomorrow|tonight|yesterday|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month|hoy|ma[nñ]ana|noche|lunes|martes|mi[eé]rcoles|jueves|viernes|pix|lembr|remind|record';
const _profSent = new Map(); // conv → assinatura enviada
let _profCleared = false;

function _textRowsOn() {
  try { return globalThis.__chatyy_native_text_rows === true; } catch { return false; }
}

function _timeShape(fmt) {
  // "13:05" / "01:05 PM" (2 dígitos, como o Intl da tela). Outro formato → null.
  try {
    const d1 = new Date(); d1.setHours(13, 5, 0, 0);
    const d2 = new Date(); d2.setHours(9, 5, 0, 0);
    const a = String(fmt(d1.toISOString()) || ''); const b = String(fmt(d2.toISOString()) || '');
    if (a === '13:05' && b === '09:05') return { h24: 1 };
    const ma = /^01:05(\s*)(\S.*)$/.exec(a); const mb = /^09:05(\s*)(\S.*)$/.exec(b);
    if (ma && mb && ma[1] === mb[1]) return { h24: 0, join: ma[1], pm: ma[2], am: mb[2] };
  } catch {}
  return null;
}

function _pushTextProfile(conv, env) {
  let ns = null;
  try { ns = require('./nativeChatStore'); } catch { return; }
  if (!ns || ns.nativeStoreApi() < 3) return;
  if (!_textRowsOn()) {
    if (!_profCleared) { _profCleared = true; try { ns.clearThreadProfiles(env.acct); } catch {} }
    _profSent.clear();
    return;
  }
  _profCleared = false;
  const ctx = env.ctx || {};
  let prof = null;
  try {
    const keyOf = env.keyOf || defaultKeyOf;
    const keysOk = keyOf({ id: 7, client_message_id: 'x' }) === 'c:x' && keyOf({ id: 7 }) === '7';
    const ts = ctx.formatTime ? _timeShape(ctx.formatTime) : null;
    const now = new Date();
    const label = ctx.dateLabel ? String(ctx.dateLabel(now.toISOString()) || '') : '';
    if (keysOk && ts && label && !ctx.isGroup && !ctx.isSavedMode) {
      prof = {
        v: 1, rev: env.rev, me: String(ctx.myEmail || env.acct || '').toLowerCase(), group: 0,
        ...ts, today: `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`, todayLabel: label,
        gapMs: 60000, allow: TEXT_ALLOW, deny: TEXT_DENY,
      };
    }
  } catch { prof = null; }
  const json = prof ? JSON.stringify(prof) : '';
  if (_profSent.get(conv) === json) return;
  _profSent.set(conv, json);
  ns.setThreadProfile(env.acct, conv, json);
}

export function setThreadMounted(conv, on) {
  if (conv == null) return;
  const k = String(conv);
  const n = (_mounted.get(k) || 0) + (on ? 1 : -1);
  if (n > 0) _mounted.set(k, n); else _mounted.delete(k);
  // desmontou: o tail passa a ser o da última janela que a lista gravou
  const e = _envs.get(k);
  if (e && !on) e.tail = undefined;
}

function _envTail(e) {
  if (e.tail === undefined) {
    try { e.tail = tailOf(e.data, e.keyOf); } catch { e.tail = null; }
    e.data = null; // não segura o array da tela depois de calcular
  }
  return e.tail;
}

function _api() {
  try { return require('../components/chat/nativeThreadList'); } catch { return null; }
}

/**
 * Operações na foto da conversa `conv` para as mensagens `msgs` (objetos do
 * servidor, como gravados no chatyy.db). null = nada a fazer.
 */
export function threadOpsFor(acct, conv, msgs) {
  const k = String(conv);
  if (!Array.isArray(msgs) || !msgs.length) return null;
  if (_mounted.get(k)) return null; // aberta: a lista nativa grava a foto sozinha
  const e = _envs.get(k);
  if (!e || e.acct !== String(acct || '').toLowerCase()) { _stats.skippedNoEnv++; return null; }
  const ctx = e.ctx;
  if (ctx && ctx.selection && ctx.selection.on) return null;
  const tail = _envTail(e);
  if (!tail || !tail.k) return null;
  const nt = _api();
  if (!nt || typeof nt.buildRow !== 'function') return null;
  const keyOf = e.keyOf || defaultKeyOf;
  const me = String((ctx && ctx.myEmail) || '').toLowerCase();
  const sorted = msgs.slice().sort((a, b) => _num(a.id) - _num(b.id));
  const ops = [];
  const newRows = [];
  let t = { ...tail };
  let readUpTo = 0; let delivUpTo = 0;
  let drop = false;
  for (const m of sorted) {
    const id = _num(m.id);
    if (!id) continue;
    const own = String(m.sender_email || '').toLowerCase() === me;
    if (id <= t.id) {
      // recibos das minhas (só sobe)
      if (own && m.read_at) readUpTo = Math.max(readUpTo, id);
      else if (own && m.delivered_at) delivUpTo = Math.max(delivUpTo, id);
      // editada / apagada / reação → reconstrói a linha (se estiver na foto)
      if (m.deleted_at || m.edited_at || (Array.isArray(m.reactions) && m.reactions.length)) {
        let why = '';
        try { why = nt.unsupportedReason ? nt.unsupportedReason(m, ctx) : ''; } catch { why = 'err'; }
        if (why) { drop = true; break; }
        let nk; let ok;
        try { nk = keyOf(m); ok = keyOf({ ...m, deleted_at: null }); } catch { continue; }
        let row = null;
        try { row = nt.buildRow({ ...m, _isFirstInGroup: true, _isLastInGroup: true }, nk, ctx); } catch { row = null; }
        if (!row) continue;
        ops.push({ op: 'put', k: ok, nk: nk !== ok ? nk : undefined, row, keep: ['first', 'last', 'name', 'nc', 'st'] });
        if (ok === t.k && nk !== ok) t = { ...t, k: nk };
        _stats.put++;
      }
      continue;
    }
    // mensagem NOVA (depois da última da foto)
    if (m.deleted_at && m.type === 'status_reply') continue; // a tela some com elas
    let why = '';
    try { why = nt.unsupportedReason ? nt.unsupportedReason(m, ctx) : ''; } catch { why = 'err'; }
    if (why) { drop = true; break; }
    const ts = _ts(m.created_at);
    const sender = String(m.sender_email || '').toLowerCase();
    const type = String(m.type || 'text');
    // álbum: mídia seguida do mesmo remetente (lote ou ≤30 s) → a tela agrupa; aqui não
    if (MEDIA.has(type) && (m._batch_id || m.batch_id
      || ((MEDIA.has(t.type) || t.type === 'album') && t.sender === sender && Number.isFinite(ts) && Number.isFinite(t.ts) && ts - t.ts <= 30000))) {
      drop = true; break;
    }
    const day = _dayKey(m.created_at);
    if (day && day !== t.day) {
      const sk = 'sep-' + day;
      let srow = null;
      try { srow = nt.buildRow({ _type: 'separator', _key: sk, date: m.created_at, _label: ctx.dateLabel ? ctx.dateLabel(m.created_at) : '' }, sk, ctx); } catch { srow = null; }
      if (!srow) { drop = true; break; }
      newRows.push(srow);
    }
    const grouped = !!t.sender && t.sender === sender && t.type !== 'system' && type !== 'system'
      && Number.isFinite(ts) && Number.isFinite(t.ts) && (ts - t.ts) <= 60000;
    if (grouped) {
      // a anterior deixa de ser a última do grupo
      const prevNew = newRows.find(r => r && r.k === t.k);
      if (prevNew) prevNew.last = 0;
      else ops.push({ op: 'set', k: t.k, set: { last: 0 } });
    }
    let k;
    try { k = keyOf(m); } catch { drop = true; break; }
    let row = null;
    try { row = nt.buildRow({ ...m, _isFirstInGroup: !grouped, _isLastInGroup: true }, k, ctx); } catch { row = null; }
    if (!row) { drop = true; break; }
    newRows.push(row);
    t = { k, id, sender, ts, type, day: day || t.day, batch: null };
  }
  if (drop) {
    _stats.dropped++;
    _envs.delete(k); // sem ambiente confiável até a tela abrir de novo
    return { conv: k, rev: e.rev, ops: [{ op: 'drop' }] };
  }
  if (newRows.length) {
    ops.push({ op: 'append', after: tail.k, rows: newRows });
    _stats.appended += newRows.length;
  }
  if (readUpTo) { ops.push({ op: 'stUpTo', id: readUpTo, st: 3 }); _stats.receipts++; }
  if (delivUpTo) { ops.push({ op: 'stUpTo', id: delivUpTo, st: 2 }); _stats.receipts++; }
  if (!ops.length) return null;
  e.tail = t;
  return { conv: k, rev: e.rev, ops };
}
