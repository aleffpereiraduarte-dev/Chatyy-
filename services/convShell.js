// services/convShell.js — [2026-10-15 native-store fase 3] CASCA LEVE da conversa.
//
// Ao abrir uma conversa, a tela inteira (app/chat-conversation.js, ~41k linhas,
// ~670 hooks) monta só DEPOIS do 1º frame. No 1º frame entra uma casca mínima:
// cabeçalho + a lista NATIVA lendo a foto do store (modules/expo-chat-store,
// pré-carregada no pressIn da home) + o composer nativo. A tela completa monta
// por baixo (após a transição) e, quando a lista dela fica pronta, a casca sai.
// Comportamento da tela = o de antes (mesmo componente, mesmos efeitos); só o
// momento em que ela monta muda (~1 transição depois).
//
// A casca só é usada quando há um "registro" desta conversa gravado pela tela
// completa numa abertura anterior (props exatas da lista nativa → mesmo rev da
// foto; posição da lista na janela; inset do composer) e o layout era simples
// (sem faixas extras entre o cabeçalho e a lista). Sem registro → tela de antes.
//
// Kill switch (OTA): globalThis.__chatyy_conv_light_shell = false
// (também desliga com globalThis.__chatyy_native_store = false).
import { Platform } from 'react-native';

const SHELL_DEFAULT_ON = true;
const MAX_RECORDS = 80;
const KEY = 'conv_shell_v1:';

let _mem = null; // { acct, map: Map<conv, rec> }
let _saveTm = null;

export function lightShellEnabled() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  try {
    const o = globalThis.__chatyy_conv_light_shell;
    if (o === false) return false;
    if (o !== true && !SHELL_DEFAULT_ON) return false;
  } catch {}
  try {
    const ns = require('./nativeChatStore');
    if (ns.nativeStoreApi() < 2) return false;
  } catch { return false; }
  try {
    const nt = require('../components/chat/nativeThreadList');
    if (!nt.isNativeThreadListAvailable() || nt.nativeListApi() < 4) return false;
  } catch { return false; }
  return true;
}

function _hash(acct) {
  try { return require('./nativeChatStore').fnv(String(acct || '').toLowerCase()); } catch { return 'x'; }
}

function _load(acct) {
  const a = String(acct || '').toLowerCase();
  if (_mem && _mem.acct === a) return _mem;
  _mem = { acct: a, map: new Map() };
  try {
    const raw = require('./mmkv').getString(KEY + _hash(a));
    if (raw) {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') for (const k of Object.keys(o)) _mem.map.set(k, o[k]);
    }
  } catch {}
  return _mem;
}

function _scheduleSave() {
  if (_saveTm) return;
  _saveTm = setTimeout(() => {
    _saveTm = null;
    const m = _mem;
    if (!m || !m.acct) return;
    try {
      const o = {};
      for (const [k, v] of m.map) o[k] = v;
      require('./mmkv').setString(KEY + _hash(m.acct), JSON.stringify(o));
    } catch {}
  }, 800);
}

/**
 * Gravado pela tela completa (nativeThreadList → <ChatyyMessageList>): props
 * da lista nativa + posição na janela. Só registros "simples" ficam.
 */
export function recordShell(acct, conv, rec) {
  if (!acct || conv == null || !rec) return;
  if (!lightShellEnabled()) return; // binário antigo / desligado: nada gravado
  try {
    const m = _load(acct);
    const k = String(conv);
    const prev = m.map.get(k);
    const next = { ...(prev || {}), ...rec, at: Date.now() };
    // teclado aberto encolhe a lista: guarda a altura "em repouso" (a maior p/
    // a mesma posição/largura) — a casca abre sempre sem teclado.
    const pf = prev && prev.frame; const nf = rec.frame;
    if (pf && nf && pf.x === nf.x && pf.y === nf.y && pf.w === nf.w && nf.h < pf.h) next.frame = pf;
    if (prev && JSON.stringify(prev) === JSON.stringify({ ...next, at: prev.at })) return;
    m.map.delete(k);
    m.map.set(k, next);
    while (m.map.size > MAX_RECORDS) m.map.delete(m.map.keys().next().value);
    _scheduleSave();
  } catch {}
}

export function getShell(acct, conv) {
  if (!acct || conv == null) return null;
  try {
    const r = _load(acct).map.get(String(conv));
    if (!r || !r.list || !r.frame || !(r.frame.h > 100)) return null;
    return r;
  } catch { return null; }
}

/** Logout / troca de conta. */
export function wipeShellRecords() {
  try { if (_mem && _mem.acct) require('./mmkv').setString(KEY + _hash(_mem.acct), ''); } catch {}
  _mem = null;
}

// ─── "a tela completa pintou" ───────────────────────────────────────────────
const _ready = new Map(); // conv → Set<cb>
export function onFullReady(conv, cb) {
  const k = String(conv);
  let s = _ready.get(k);
  if (!s) { s = new Set(); _ready.set(k, s); }
  s.add(cb);
  return () => { try { s.delete(cb); if (!s.size) _ready.delete(k); } catch {} };
}
export function notifyFullReady(conv) {
  const s = _ready.get(String(conv));
  if (!s) return;
  for (const cb of Array.from(s)) { try { cb(); } catch {} }
}

// ─── medição (beacon) ───────────────────────────────────────────────────────
// t0 = toque na linha da home (ChatListTab) → shell pintou (onStore/onReady da
// lista da casca) → tela completa pronta.
let _openT0 = 0;
let _openConv = '';
let _beacons = 0;
export function markOpenTap(conv) { _openT0 = Date.now(); _openConv = String(conv); }
export function openElapsed(conv) { return _openConv === String(conv) && _openT0 ? Date.now() - _openT0 : -1; }
export function shellBeacon(info) {
  if (_beacons >= 8) return;
  _beacons++;
  try {
    setTimeout(() => {
      try {
        const api = require('./api').default || require('./api');
        api?.apiCall?.('callkit_diag', { info: `conv_shell ${info || ''}`.slice(0, 400), platform: Platform.OS }, 'POST')?.catch?.(() => {});
      } catch {}
    }, 0);
  } catch {}
}
