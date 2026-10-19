// services/captureBlock.js — [2026-10-19 secure-view] "Chatyy é privacidade total".
//
// 1. Ajuste GLOBAL "Bloquear capturas de tela nas conversas" (padrão DESLIGADO,
//    opt-in do usuário; Configurações → Privacidade). Ligado = TODAS as conversas
//    ficam protegidas para quem ligou. Fonte de verdade instantânea = espelho
//    local por conta (MMKV); o servidor guarda em chat_privacy_set/get
//    (`block_screenshots`, chat_user_defaults) e re-hidrata outros aparelhos.
// 2. "Escopos" de proteção abertos agora (conversa com privacidade avançada,
//    modo temporário ou o ajuste global): as telas empurradas por cima da
//    conversa (Dados do contato, visualizador) protegem também.
// 3. Gate da view nativa <ChatyySecureView> (iOS): print/gravação saem com
//    "Captura de tela bloqueada". Kill switch globalThis.__chatyy_secure_view = false.
import { useEffect, useReducer } from 'react';
import { Platform } from 'react-native';

const PREF_KEY = 'chat_capture_block_v1'; // { [email]: 0|1 }
let _prefs; // objeto | undefined
const _subs = new Set();
let _wired = false;

function _email() {
  try { return String(require('./api').getActiveAccountEmail?.() || '').trim().toLowerCase(); } catch { return ''; }
}

function _load() {
  if (_prefs !== undefined) return _prefs;
  _prefs = {};
  try {
    const raw = require('./mmkv').getString?.(PREF_KEY);
    const o = raw ? JSON.parse(raw) : null;
    if (o && typeof o === 'object') _prefs = o;
  } catch {}
  return _prefs;
}

function _save() {
  try { require('./mmkv').setString?.(PREF_KEY, JSON.stringify(_prefs || {})); } catch {}
}

function _emit() {
  for (const cb of [..._subs]) { try { cb(); } catch {} }
}

function _truthy(v) {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

// Valor vindo do servidor (settingsCache 'privacy') → espelho local.
function _wire() {
  if (_wired) return;
  _wired = true;
  try {
    const sc = require('./settingsCache');
    const onPriv = (x) => {
      if (x && typeof x === 'object' && Object.prototype.hasOwnProperty.call(x, 'block_screenshots') && x.block_screenshots != null) {
        noteServerCaptureBlock(_truthy(x.block_screenshots));
      }
    };
    sc.subscribe?.('privacy', onPriv);
    try { onPriv(sc.peek?.('privacy')); } catch {}
  } catch { _wired = false; }
}

/** Ajuste global ligado para a conta ativa? */
export function isCaptureBlockGlobal() {
  _wire();
  const e = _email();
  if (!e) return false;
  return _truthy(_load()[e]);
}

/** Grava o ajuste local (a tela de Privacidade manda o mesmo ao servidor). */
export function setCaptureBlockGlobal(on) {
  const e = _email();
  if (!e) return;
  const p = _load();
  const v = on ? 1 : 0;
  if (p[e] === v) return;
  p[e] = v;
  _save();
  _emit();
}

export function noteServerCaptureBlock(on) {
  setCaptureBlockGlobal(!!on);
}

export function subscribeCaptureBlock(cb) {
  _subs.add(cb);
  _wire();
  return () => _subs.delete(cb);
}

/** React: ajuste global ao vivo. `_v` = versão (React Compiler não memoiza o valor velho). */
function _globalAt(_v) { return isCaptureBlockGlobal(); }
export function useCaptureBlockGlobal() {
  const [ver, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribeCaptureBlock(force), []);
  return _globalAt(ver);
}

// ─── Escopos abertos ─────────────────────────────────────────────────────────
const _scopes = new Map(); // cid → Set(motivos)
const _scopeSubs = new Set();

function _cidKey(cid) {
  const n = String(cid == null ? '' : cid).trim();
  return n && n !== '0' && n !== 'undefined' && n !== 'null' ? n : '';
}

/** A conversa `cid` está aberta e protegida (motivo: 'adv' | 'vanish' | 'global'). */
export function setCaptureScope(cid, on, reason) {
  const k = _cidKey(cid);
  if (!k) return;
  const r = reason || 'adv';
  let set = _scopes.get(k);
  if (on) {
    if (set && set.has(r)) return;
    if (!set) { set = new Set(); _scopes.set(k, set); }
    set.add(r);
  } else {
    if (!set || !set.has(r)) return;
    set.delete(r);
    if (!set.size) _scopes.delete(k);
  }
  for (const cb of [..._scopeSubs]) { try { cb(); } catch {} }
}

/** cid protegido aberto agora? Sem cid = a conversa protegida aberta mais recente (a de baixo). */
export function getCaptureScope(cid) {
  const k = _cidKey(cid);
  if (k) {
    const v = _scopes.get(k);
    return v ? { cid: k, reasons: [...v] } : null;
  }
  let last = null;
  for (const [key, v] of _scopes) last = { cid: key, reasons: [...v] };
  return last;
}

function _scopeAt(cid, _v) { return getCaptureScope(cid); }
export function useCaptureScope(cid) {
  const [ver, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    _scopeSubs.add(force);
    return () => { _scopeSubs.delete(force); };
  }, []);
  return _scopeAt(cid, ver);
}

// ─── View nativa ─────────────────────────────────────────────────────────────
let _SV; // componente | null
/** <ChatyySecureView> nativo (iOS, apiVersion ≥ 3) ou null. */
export function getNativeSecureView() {
  if (_SV !== undefined) return _SV;
  _SV = null;
  if (Platform.OS !== 'ios') return null;
  try { if (globalThis.__chatyy_secure_view === false) return null; } catch {}
  try {
    const m = require('../modules/expo-chat-privacy');
    _SV = (m && typeof m.getSecureView === 'function' && m.getSecureView()) || null;
  } catch { _SV = null; }
  return _SV;
}

/** iOS: o print sai com o aviso "Captura de tela bloqueada" (não precisa do escudo preto na gravação). */
export function secureViewAvailable() {
  return !!getNativeSecureView();
}
