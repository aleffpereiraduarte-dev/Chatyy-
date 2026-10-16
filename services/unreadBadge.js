// services/unreadBadge.js — [2026-10-15 unread-instant] Fonte LOCAL única dos
// contadores de não lidas (linha da lista, aba "Conversas", ícone do app e
// banners da central). Founder: "abri a conversa → tem que limpar da lista e
// do contador NA HORA".
//
// Antes: a linha zerava na hora (otimista), mas
//   • ícone do app: só via refreshBadgeCount() = POST chat_mark_read (0,3-2,5 s)
//     + chat_list COMPLETO (0,3-0,6 s); a chamada do finally do chatRead não
//     excluía a conversa → podia regravar o número velho;
//   • aba "Conversas" (app/chat.js): poll de 60 s;
//   • banners: só os que tinham conversation_id e o ícone caía só "-N banners".
// Agora: markConversationReadLocal(cid) zera tudo localmente na hora (lista via
// evento local chat_read, aba via subscribe, ícone recalculado daqui, banners
// da conversa removidos). O read ao servidor segue pelos caminhos de sempre
// (gate de visibilidade/foco intocado — isto NÃO envia recibo de leitura).
//
// Sem dependência circular: pushNotifications/websocket via require tardio.

import { Platform } from 'react-native';

const _conv = new Map(); // cid → { unread, muted }
let _listKnown = false;  // a lista já publicou ao menos uma vez
let _total = 0;          // soma das não silenciadas (mesma regra do servidor)
const _subs = new Set();
// Conversas lidas localmente há pouco: um chat_list/chat_unread_count que
// chega ANTES do servidor/réplica aplicar o read não pode ressuscitar o número.
const _recentReads = new Map(); // cid → ts (ms)
const RECENT_TTL = 20000;

function _recomputeTotal() {
  let t = 0;
  for (const v of _conv.values()) if (!v.muted) t += v.unread || 0;
  return t;
}

function _notify() {
  for (const fn of Array.from(_subs)) { try { fn(_total); } catch {} }
}

let _lastIcon = -1;
function _applyIcon(n) {
  if (Platform.OS === 'web') return; // web: webBadge (title/setAppBadge)
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v === _lastIcon) return;
  _lastIcon = v;
  try { require('./pushNotifications').setBadgeCount?.(v)?.catch?.(() => {}); } catch {}
}

/** ChatListTab publica o estado da lista sempre que `conversations` muda. */
export function publishListUnread(conversations) {
  try {
    const seen = new Set();
    for (const c of conversations || []) {
      const id = c && (c.id ?? c.conversation_id);
      if (id == null) continue;
      const k = String(id);
      seen.add(k);
      // [2026-10-15 notif-read-sync] lastId = maior id que a lista já viu (guarda
      // da reconciliação de banners: banner com id > lastId = lista atrasada).
      const lm = Number(c.last_message?.id ?? c.last_message_id) || 0;
      _conv.set(k, { unread: Math.max(0, Number(c.unread_count) || 0), muted: !!c.muted, lastId: lm });
    }
    // Linhas que saíram da lista (apagada/arquivada) não contam mais.
    for (const k of Array.from(_conv.keys())) if (!seen.has(k)) _conv.delete(k);
    _listKnown = true;
    const t = _recomputeTotal();
    if (t !== _total) { _total = t; _notify(); }
    _scheduleNotifReconcile(1500);
  } catch {}
}

// [2026-10-15 notif-read-sync] Banners de conversas que a lista JÁ mostra como
// lidas (lidas aqui, em outro aparelho, na web) somem da central — a cada
// publicação da lista (trailing 1,5 s) e ao voltar ao 1º plano. Só remove banner
// cuja msg a lista já viu (id <= lastId) com unread 0 → lista atrasada nunca
// apaga banner novo. Kill: globalThis.__chatyy_notif_reconcile_off = true.
let _reconT = null;
let _appStateSub = null;
function _scheduleNotifReconcile(ms) {
  if (Platform.OS === 'web') return;
  try {
    if (!_appStateSub) {
      const { AppState } = require('react-native');
      _appStateSub = AppState.addEventListener?.('change', (s) => { if (s === 'active') _scheduleNotifReconcile(2500); }) || true;
    }
  } catch { _appStateSub = true; }
  if (_reconT) clearTimeout(_reconT);
  _reconT = setTimeout(() => {
    _reconT = null;
    try { require('./pushNotifications').reconcileReadNotifications?.()?.catch?.(() => {}); } catch {}
  }, ms);
}

/** Estado local de uma conversa p/ a reconciliação: { unread, muted, lastId } ou null. */
export function getConvReadState(cid) {
  if (!_listKnown) return null;
  const v = _conv.get(String(cid ?? ''));
  return v ? { unread: v.unread || 0, muted: !!v.muted, lastId: v.lastId || 0 } : null;
}

export function getLocalUnreadTotal() { return _listKnown ? _total : null; }
export function hasLocalList() { return _listKnown; }

export function subscribeUnreadTotal(fn) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

/** true = a conversa foi lida localmente há < 20 s (servidor pode estar atrás). */
export function wasReadLocallyRecently(cid) {
  const k = String(cid ?? '');
  const ts = _recentReads.get(k);
  if (!ts) return false;
  if (Date.now() - ts > RECENT_TTL) { _recentReads.delete(k); return false; }
  return true;
}
export function recentLocalReadIds() {
  const out = [];
  for (const k of Array.from(_recentReads.keys())) if (wasReadLocallyRecently(k)) out.push(k);
  return out;
}

/** Uma msg NOVA de outra pessoa chegou nesta conversa → a proteção acaba. */
export function noteIncomingUnread(cid) {
  try { _recentReads.delete(String(cid ?? '')); } catch {}
}

/**
 * Zera LOCALMENTE e na hora tudo que mostra "não lida" desta conversa:
 *  - linha da lista (JS e nativa) via evento local `chat_read` (ChatListTab);
 *  - total da aba / ícone do app (recalculado deste store);
 *  - banners já entregues da conversa (iOS/Android).
 * opts.emitList=false quando quem chama já atualizou a lista (evita eco).
 * opts.email = conta ativa (reader_email do evento local).
 */
export function markConversationReadLocal(cid, opts = {}) {
  if (cid == null || cid === '') return;
  const k = String(cid);
  _recentReads.set(k, Date.now());
  if (_recentReads.size > 200) _recentReads.delete(_recentReads.keys().next().value);
  const prev = _conv.get(k);
  if (prev && prev.unread) {
    _conv.set(k, { ...prev, unread: 0 });
    _total = _recomputeTotal();
    _notify();
  }
  if (_listKnown) _applyIcon(_total);
  else if (prev && prev.unread && !prev.muted && _lastIcon > 0) _applyIcon(_lastIcon - prev.unread);
  if (opts.emitList !== false) {
    try {
      const mailWs = require('./websocket').default;
      const me = String(opts.email || '').toLowerCase();
      if (me) mailWs?._emit?.('chat_read', { conversation_id: cid, reader_email: me, email: me, last_read_id: 0, _local: true });
    } catch {}
  }
  if (opts.dismiss !== false && Platform.OS !== 'web') {
    try { require('./pushNotifications').dismissConversationNotifications?.(cid, { keepBadge: _listKnown, upTo: Number(opts.upTo) || 0 })?.catch?.(() => {}); } catch {}
  }
}

/** Valor que o servidor mandou (push/refresh) → o ícone fica coerente com o store. */
export function noteIconBadge(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  _lastIcon = v;
}

export function resetUnreadStore() {
  _conv.clear(); _recentReads.clear(); _listKnown = false; _total = 0; _lastIcon = -1; _notify();
}
