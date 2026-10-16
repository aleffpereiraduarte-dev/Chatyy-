// services/rowZoomTransition.js — [wave8 row-zoom] "A CONVERSA CRESCE A PARTIR DA LINHA".
//
// Abordagem (a de MENOR risco com react-native-screens 4.23): nada de delegate
// próprio no UINavigationController do RNSScreenStack nem animação custom de
// Fragment. Em vez disso:
//   1. a lista nativa (modules/expo-chat-conversation-list) manda no onRowPress
//      o `frame` da linha tocada (navigationHint) → noteRowHint();
//   2. ChatListTab.navigateToConversation chama openWithRowZoom(): aguarda o
//      módulo nativo ChatyyRowZoom montar um overlay (snapshot) idêntico à tela
//      (≤ 1 frame) e SÓ ENTÃO faz o push — que, para ESTA rota, sai com
//      animation:'none' (pushAnimationFor, lido pelas options da rota em
//      app/_layout.js);
//   3. a casca leve da conversa (ConvLightShellHost) pinta o 1º frame e chama
//      noteConversationFirstFrame() → o overlay anima (buraco crescendo da linha
//      até a tela com a conversa REAL por dentro; lista com parallax −30 % e
//      escurecida; mola ζ 0.86 ~0.42 s);
//   4. no fim (evento nativo ou teto JS) a rota recebe de volta a animação
//      padrão via navigation.setOptions → o VOLTAR é o pop nativo de sempre
//      (gesto interativo iOS / ios_from_right Android).
// Qualquer falha (módulo ausente, frame velho, begin=false/timeout, push que
// virou dedup/pop/replace) → push padrão, como antes.
//
// Kill switch (OTA): globalThis.__chatyy_row_zoom_transition = false
//   'always' = também quando a conversa não tem casca leve (abre a tela cheia).
import { Platform, Dimensions } from 'react-native';

const HINT_MAX_AGE_MS = 700;   // toque → navigate (trava biométrica etc. = velho)
const BEGIN_TIMEOUT_MS = 160;  // overlay nativo não respondeu → push padrão
const SETTLE_CAP_MS = 1600;    // teto JS p/ devolver a animação padrão à rota

let _hint = null;     // { id, frame, at }
let _pending = null;  // { id, key, fb, at, done, cbs:Set, timer }
let _sub = null;

function _mod() {
  try { return require('../modules/expo-chat-row-zoom').getRowZoomModule(); } catch { return null; }
}

function _killState() {
  try {
    const o = globalThis.__chatyy_row_zoom_transition;
    if (o === false || o === 0 || o === 'off') return 'off';
    if (o === 'always') return 'always';
  } catch {}
  return 'on';
}

export function rowZoomEnabled() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  if (_killState() === 'off') return false;
  return !!_mod();
}

/** Lista nativa → frame da linha tocada (coords da janela, unidade nativa). */
export function noteRowHint(id, frame) {
  try {
    if (id == null || !frame) { _hint = null; return; }
    const x = Number(frame.x); const y = Number(frame.y); const w = Number(frame.w); const h = Number(frame.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) { _hint = null; return; }
    _hint = { id: String(id), frame: { x, y, w, h }, at: Date.now() };
  } catch { _hint = null; }
}

function _takeHint(id) {
  const h = _hint;
  _hint = null;
  if (!h || h.id !== String(id) || Date.now() - h.at > HINT_MAX_AGE_MS) return null;
  return h;
}

function _ensureSub(mod) {
  if (_sub || !mod || typeof mod.addListener !== 'function') return;
  try { _sub = mod.addListener('onZoomEnd', () => { _settle(); }); } catch { _sub = null; }
}

function _settle() {
  const p = _pending;
  if (!p || p.done) return;
  p.done = true;
  if (p.timer) { clearTimeout(p.timer); p.timer = null; }
  const cbs = Array.from(p.cbs);
  p.cbs.clear();
  for (const cb of cbs) { try { cb(); } catch {} }
  // a tela já devolveu a animação (setOptions) no callback; solta o estado
  setTimeout(() => { if (_pending === p) _pending = null; }, 0);
}

function _alreadyInStack(id) {
  try {
    const info = require('./openConversation').getConversationStackInfo();
    return !!(info && Array.isArray(info.convs) && info.convs.some(c => String(c.id) === String(id)));
  } catch { return false; }
}

function _tabletSplit() {
  try {
    return require('../utils/responsive').isNativeTabletSplit(Dimensions.get('window').width);
  } catch { return false; }
}

// A casca leve só entra sem "não lidas" e com registro gravado — sem ela o 1º
// frame é a tela cheia (pesada) e o crescimento revelaria uma tela vazia.
function _shellLikely(acct, id, unread) {
  if (_killState() === 'always') return true;
  if (Number(unread) > 0) return false;
  try {
    const cs = require('./convShell');
    if (!cs.lightShellEnabled()) return false;
    return !!cs.getShell(String(acct || '').toLowerCase(), String(id));
  } catch { return false; }
}

/**
 * Abre a conversa crescendo a partir da linha. Devolve true se assumiu (ela
 * mesma chama `open()` — já, ou depois do overlay); false = o chamador abre.
 * @param id    conversa
 * @param opts  { open: () => resultado de openConversation, dark, acct, unread }
 */
export function openWithRowZoom(id, opts = {}) {
  const hint = _takeHint(id);
  if (!hint || typeof opts.open !== 'function') return false;
  if (!rowZoomEnabled() || _tabletSplit()) return false;
  if (_pending && !_pending.done) return false;
  if (_alreadyInStack(id)) return false;
  if (!_shellLikely(opts.acct, id, opts.unread)) return false;
  const mod = _mod();
  if (!mod || typeof mod.begin !== 'function') return false;
  _ensureSub(mod);

  let decided = false;
  const fallback = () => {
    if (decided) return;
    decided = true;
    try { opts.open(); } catch {}
  };
  const tm = setTimeout(() => {
    if (decided) return;
    fallback();
    try { mod.cancel(); } catch {}
  }, BEGIN_TIMEOUT_MS);

  let pr;
  try {
    pr = mod.begin({ ...hint.frame, dark: !!opts.dark, radius: 10, maxWait: 220 });
  } catch {
    clearTimeout(tm);
    return false;
  }
  Promise.resolve(pr).then((ok) => {
    if (decided) { if (ok) { try { mod.cancel(); } catch {} } return; }
    clearTimeout(tm);
    if (!ok) { fallback(); return; }
    decided = true;
    const p = { id: String(id), key: null, fb: null, at: Date.now(), done: false, cbs: new Set(), timer: null };
    _pending = p;
    let res = null;
    try { res = opts.open(); } catch { res = 'error'; }
    if (res !== 'push') {
      // dedup/same/pop/replace: não houve rota nova p/ crescer
      _pending = null;
      try { mod.cancel(); } catch {}
      return;
    }
    p.timer = setTimeout(() => {
      // nada chegou (casca não pintou / evento perdido): solta o overlay e a rota
      try { mod.ready(); } catch {}
      setTimeout(_settle, 700);
    }, SETTLE_CAP_MS - 700);
  }, () => {
    if (decided) return;
    clearTimeout(tm);
    fallback();
  });
  return true;
}

/**
 * options da rota chat-conversation (app/_layout.js): 'none' só para a rota
 * recém-empurrada por openWithRowZoom (até a transição acabar); senão `fb`.
 */
export function pushAnimationFor(route, fb) {
  const p = _pending;
  if (!p || p.done || !route) return fb;
  if (Date.now() - p.at > SETTLE_CAP_MS + 1000) { _pending = null; return fb; }
  if (p.key) return route.key === p.key ? 'none' : fb;
  const rid = route.params && route.params.id != null ? String(route.params.id) : '';
  if (rid && rid === p.id) {
    p.key = route.key;
    p.fb = fb;
    return 'none';
  }
  return fb;
}

/** A rota desta conversa está no meio da transição linha→conversa? */
export function isZoomingFor(convId) {
  const p = _pending;
  return !!(p && !p.done && p.id === String(convId));
}

/** cb quando a transição terminar (ou já). Devolve unsubscribe. */
export function onZoomEnd(convId, cb) {
  const p = _pending;
  if (!p || p.done || p.id !== String(convId)) { try { cb(); } catch {} return () => {}; }
  p.cbs.add(cb);
  return () => { try { p.cbs.delete(cb); } catch {} };
}

/** A animação a devolver à rota depois da transição (a que ela teria). */
export function restoreAnimationFor(convId) {
  const p = _pending;
  if (p && p.id === String(convId) && p.fb) return p.fb;
  return undefined;
}

/** 1º frame da conversa pintado (casca leve ou tela cheia) → anima. */
export function noteConversationFirstFrame(convId) {
  if (!isZoomingFor(convId)) return;
  const mod = _mod();
  try { mod && mod.ready(); } catch {}
}
