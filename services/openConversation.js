// [2026-10-12 nav-dedup] Single entry point for "open this conversation".
//
// Founder (iPhone): "quando abre o chat às vezes abre o mesmo chat 2 vezes" —
// the same /chat-conversation got pushed twice and back revealed the SAME chat
// again. Causes found (see report): every entry point did its own blind
// router.push/replace (list row, push tap, deep link, search, contacts,
// chat-new, voicemail recorder, starred, status reply…); the list's 800 ms
// time lock is measured when the JS thread processes the tap, so a second tap
// queued while the 38k-line conversation screen was mounting slipped through;
// "replace back into the conversation" flows (chat-new add-member, voicemail
// recorder, saved-messages) stacked a 2nd copy of a chat already below them;
// and the push path's "chat already open" check was cleared by the OLD
// screen's unmount after a replace.
//
// This helper, for any href aimed at /chat-conversation:
//   1. ignores a 2nd open of the same conversation within WINDOW_MS;
//   2. top screen already shows that conversation → no-op (router.setParams for
//      jump targets such as scrollToMessageId);
//   3. that conversation already in the stack below → pops back to it instead
//      of pushing a duplicate (WhatsApp: one instance per chat);
//   4. otherwise push (or replace when the caller asked for it, or when the top
//      screen is ANOTHER conversation: chat→chat hops never stack).
// Notification-response id dedup lives in pushNotifications.js and also goes
// through here.
import { router as globalRouter } from 'expo-router';

const WINDOW_MS = 1200;
const CONV_PATH = '/chat-conversation';
// Params that ask the screen to DO something on mount. When the target chat is
// already open we remount it (replace) so the action is not silently lost.
const ACTION_PARAMS = ['autocall', 'startCall', 'autoCall', 'prefill', 'replyTo', 'replyStatus',
  '_shared_uri', '_shared_type', '_shared_text', '_shared_name', '_shared_files', 'voicemail_id'];
// Params the open screen can take via setParams without a remount.
const SOFT_PARAMS = ['scrollToMessageId', 'highlightMessageId'];

let _last = null; // { key, at }

function _decode(v) {
  try { return decodeURIComponent(String(v).replace(/\+/g, ' ')); } catch { return String(v); }
}

// href (string | { pathname, params }) → { pathname, params }
export function parseConversationHref(href) {
  if (href && typeof href === 'object') {
    return { pathname: String(href.pathname || ''), params: { ...(href.params || {}) } };
  }
  const s = String(href || '');
  const q = s.indexOf('?');
  const pathname = q >= 0 ? s.slice(0, q) : s;
  const params = {};
  if (q >= 0) {
    for (const kv of s.slice(q + 1).split('&')) {
      if (!kv) continue;
      const i = kv.indexOf('=');
      const k = i >= 0 ? kv.slice(0, i) : kv;
      if (k) params[_decode(k)] = i >= 0 ? _decode(kv.slice(i + 1)) : '';
    }
  }
  return { pathname, params };
}

function _isConvPath(p) {
  const s = String(p || '').replace(/^\/+/, '/');
  return s === CONV_PATH || s === 'chat-conversation';
}

function _lc(v) { return String(v || '').trim().toLowerCase(); }

// Identity of the conversation a param bag points at.
function _convKey(params) {
  const id = parseInt(params?.id, 10);
  if (id > 0) return 'id:' + id;
  const em = _lc(params?.email || params?.peer);
  if (em) return 'em:' + em;
  return null;
}

// Does an existing stack route show the conversation `params` points at?
function _routeMatches(route, params) {
  if (!route || route.name !== 'chat-conversation') return false;
  const rp = route.params || {};
  const id = parseInt(params?.id, 10);
  const rid = parseInt(rp.id, 10);
  if (id > 0 && rid > 0) return id === rid;
  const em = _lc(params?.email || params?.peer);
  const rem = _lc(rp.email || rp.peer);
  // Email-only open vs a direct chat in the stack (its id may have been
  // resolved in place via setParams, the email param stays).
  if (em && rem && em === rem) {
    const t = String(params?.type || 'direct');
    const rt = String(rp.type || 'direct');
    return t === 'direct' && rt === 'direct';
  }
  return false;
}

function _rootState() {
  try {
    const { store } = require('expo-router/build/global-state/router-store');
    const nav = store?.navigationRef?.current;
    if (nav && typeof nav.getRootState === 'function') return { nav, state: nav.getRootState() };
  } catch {}
  return { nav: null, state: null };
}

// The focused navigator that holds chat-conversation routes (root Stack today;
// walks the focused chain so a future nested layout keeps working).
function _findConvStack(state) {
  let s = state;
  let guard = 0;
  while (s && Array.isArray(s.routes) && guard++ < 8) {
    if (Array.isArray(s.routeNames) ? s.routeNames.includes('chat-conversation') : s.routes.some(r => r.name === 'chat-conversation')) return s;
    const focused = s.routes[typeof s.index === 'number' ? s.index : s.routes.length - 1];
    s = focused && focused.state;
  }
  return null;
}

// QA/diagnostics: how many /chat-conversation instances are in the stack.
export function getConversationStackInfo() {
  try {
    const { state } = _rootState();
    const st = _findConvStack(state);
    if (!st) return { depth: 0, convs: [], top: null };
    const convs = st.routes.filter(r => r.name === 'chat-conversation').map(r => ({
      id: r.params?.id ?? null, email: r.params?.email ?? null,
    }));
    const top = st.routes[st.index]?.name || null;
    return { depth: st.routes.length, convs, top, names: st.routes.map(r => r.name) };
  } catch { return { depth: 0, convs: [], top: null }; }
}
try { if (typeof globalThis !== 'undefined') globalThis.__chatyyConvStack = getConversationStackInfo; } catch {}

// Reset the time window (e.g. tests or after an explicit close).
export function resetConversationOpenGuard() { _last = null; }

// [2026-10-19 kb-native] Lista → conversa sem teclado piscando: o campo de
// busca (ou qualquer TextInput RN) da tela de origem solta o teclado JÁ, no
// mesmo frame em que o push começa — ele desce junto com a transição em vez de
// aparecer por cima da conversa e só cair no Keyboard.dismiss() do mount. Não
// alcança o composer nativo (conversa → conversa: o UITextView solta sozinho no
// viewWillDisappear). Kill switch: globalThis.__chatyy_kb_native_transitions=false.
function _kbDismissForOpen() {
  try {
    if (!require('../utils/kbNativeTransitions').kbNativeTransitionsOn()) return;
    const RN = require('react-native');
    if (RN.Platform.OS !== 'web') RN.Keyboard.dismiss();
  } catch {}
}

/**
 * Open a conversation without ever stacking a duplicate.
 * @param href   string or { pathname, params } — same shapes router.push takes.
 * @param opts   { router?, replace?: boolean, source?: string }
 *   router  — router-like object (ChatListTab's tablet-split listRouter); its
 *             push is used for the plain "new screen" case.
 *   replace — caller is a transient screen (chat-new, recorder, loader) that
 *             should leave the stack when the chat opens.
 * @returns 'dedup' | 'same' | 'pop' | 'replace' | 'push' | 'passthrough'
 */
export function openConversation(href, opts = {}) {
  const r = opts.router || globalRouter;
  const { pathname, params } = parseConversationHref(href);
  const now = Date.now();

  if (!_isConvPath(pathname)) {
    // Non-conversation targets (e.g. /saved-messages) still get the
    // double-tap window, nothing else.
    const k = 'path:' + pathname;
    if (_last && _last.key === k && now - _last.at < WINDOW_MS) return 'dedup';
    _last = { key: k, at: now };
    if (opts.replace) r.replace(href); else r.push(href);
    return 'passthrough';
  }

  // [2026-10-14 tipo-conv] Quem abre só com `id` (busca, notificações, toast, perfil, comunidade,
  // links /j/…) não sabe o tipo → a tela assumia direct e tratava grupo como contato. Preenche
  // pelo tipo da conversa conhecida (handoff/snapshot da lista); desconhecido segue sem `type`.
  if (!params.type && params.id != null && params.id !== '') {
    try {
      const c = require('../utils/chatOpenHandoff').peekOpenConversation(params.id);
      if (c && typeof c.type === 'string' && c.type) {
        params.type = c.type;
        href = { pathname, params };
      }
    } catch {}
  }

  const key = _convKey(params);
  if (key && _last && _last.key === key && now - _last.at < WINDOW_MS) return 'dedup';
  if (key) _last = { key, at: now };

  const hasAction = ACTION_PARAMS.some(k => params[k] != null && params[k] !== '');
  let stack = null;
  let nav = null;
  try { const rs = _rootState(); nav = rs.nav; stack = _findConvStack(rs.state); } catch {}

  // Active-conversation tracker (set by the open chat on mount) is a second
  // signal for "already on top" when nav state isn't readable yet.
  let activeId = null;
  try { activeId = require('./pushNotifications').getActiveConversation?.(); } catch {}

  if (stack && Array.isArray(stack.routes) && stack.routes.length) {
    const topIdx = typeof stack.index === 'number' ? stack.index : stack.routes.length - 1;
    const top = stack.routes[topIdx];
    if (key && _routeMatches(top, params)) {
      if (hasAction) { r.replace(href); return 'replace'; }
      const soft = {};
      for (const k of SOFT_PARAMS) if (params[k] != null && params[k] !== '') soft[k] = String(params[k]);
      if (Object.keys(soft).length) { try { r.setParams?.(soft); } catch {} }
      return 'same';
    }
    if (key) {
      let found = -1;
      for (let i = topIdx - 1; i >= 0; i--) {
        if (_routeMatches(stack.routes[i], params)) { found = i; break; }
      }
      if (found >= 0 && nav) {
        try {
          const { StackActions } = require('@react-navigation/native');
          _kbDismissForOpen();
          nav.dispatch({ ...StackActions.pop(topIdx - found), target: stack.key });
          if (hasAction) { r.replace(href); return 'replace'; }
          const soft = {};
          for (const k of SOFT_PARAMS) if (params[k] != null && params[k] !== '') soft[k] = String(params[k]);
          if (Object.keys(soft).length) { try { r.setParams?.(soft); } catch {} }
          return 'pop';
        } catch {}
      }
    }
    _kbDismissForOpen();
    if (opts.replace || (top && top.name === 'chat-conversation' && !opts.router)) {
      r.replace(href);
      return 'replace';
    }
    r.push(href);
    return 'push';
  }

  // No readable nav state: fall back to the active-conversation tracker.
  const id = parseInt(params.id, 10);
  if (id > 0 && activeId != null && String(activeId) === String(id) && !hasAction) return 'same';
  _kbDismissForOpen();
  if (opts.replace || (activeId != null && !opts.router)) { r.replace(href); return 'replace'; }
  r.push(href);
  return 'push';
}

// [notmember-ryw 2026-10-17] "Fala oi" (contato entrou), seguir de volta, etc.: abre a conversa
// DIRETA com `email` garantindo o get-or-create ANTES de navegar. Antes a tela
// abria só com ?email=, criava a conversa lá dentro e disparava as leituras
// (chat_info/chat_messages) no edge ~150 ms depois — a réplica ainda sem a
// linha de membro respondia 403 "Not a member" e a tela ficava no erro.
// 1) conversa já no cache local → abre na hora com o id;
// 2) senão chat_create (devolve a existente ou cria) com teto de 2,5 s;
// 3) falhou/estourou → cai no caminho antigo (?email=), que resolve na tela.
const _directInflight = new Map();
export async function openDirectConversation(email, extraParams = {}, opts = {}) {
  const em = _lc(email);
  if (!em) return 'noop';
  const base = { email: em, type: 'direct', ...(extraParams || {}) };
  let id = 0;
  try {
    const { getCachedConversations } = require('./chatCache');
    const cached = await getCachedConversations();
    if (Array.isArray(cached)) {
      const hit = cached.find(c => c && (c.type === 'direct' || !c.type)
        && _lc(c.other_email || c.contact_email) === em);
      if (hit && hit.id) id = parseInt(hit.id, 10) || 0;
    }
  } catch {}
  if (!id) {
    try {
      let p = _directInflight.get(em);
      if (!p) {
        const api = require('./api');
        p = Promise.race([
          api.chatCreate([em], '', 'direct'),
          new Promise(res => setTimeout(() => res(null), 2500)),
        ]).finally(() => { _directInflight.delete(em); });
        _directInflight.set(em, p);
      }
      const r = await p;
      id = parseInt(r?.data?.id || r?.data?.conversation_id, 10) || 0;
    } catch {}
  }
  const params = id ? { ...base, id: String(id) } : base;
  return openConversation({ pathname: CONV_PATH, params }, opts);
}

export default openConversation;
// QA hook (web Playwright + debugging): drive the guard without UI.
try { if (typeof globalThis !== 'undefined') globalThis.__chatyyOpenConv = openConversation; } catch {}
