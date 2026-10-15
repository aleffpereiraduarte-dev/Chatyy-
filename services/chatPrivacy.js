// services/chatPrivacy.js — [2026-10-14 adv-privacy]
//
// "Privacidade avançada da conversa" (nível WhatsApp). Flag POR CONVERSA,
// igual para todos os participantes (chat_conversations.advanced_privacy):
//   • Android: FLAG_SECURE na tela da conversa e nos visualizadores
//     (expo-screen-capture, já no binário; Dialog do visualizador nativo via
//     modules/expo-media-viewer `secure`).
//   • iOS: escudo preto durante gravação/espelhamento (modules/expo-chat-privacy
//     — binário novo) + aviso "Fulano tirou um print" (expo-screen-capture
//     addScreenshotListener → chat_screenshot_notice).
//   • Bloqueia: salvar na galeria automático, exportar, encaminhar/salvar
//     mídia, Bia lendo a conversa (o servidor também barra).
//   • Web: marca d'água com o @ do visualizador + sem clique direito/arrastar.
//
// Store em memória + espelho persistido (MMKV/localStorage) para o 1º frame e
// para o filtro da galeria (downloads em segundo plano). O flag é da conversa
// (não do usuário), então não vaza nada entre contas.

import { useEffect, useReducer } from 'react';
import { Platform, DeviceEventEmitter } from 'react-native';

const STORE_KEY = 'chat_adv_privacy_v1';
const _map = new Map(); // cid → { enabled, screenshotNotice, at }
const _subs = new Set();
let _hydrated = false;
let _wsWired = false;
// Conversas protegidas abertas agora (tela em foco) — filtro da galeria para
// downloads sem conversationId.
const _openProtected = new Set();

function _key(cid) {
  const n = String(cid == null ? '' : cid).trim();
  return n && n !== '0' && n !== 'undefined' && n !== 'null' ? n : '';
}

function _hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const raw = require('./mmkv').getString?.(STORE_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === 'object' && !_map.has(k)) {
          _map.set(k, { enabled: !!v.e, screenshotNotice: v.s !== false, at: Number(v.t) || 0 });
        }
      }
    }
  } catch {}
}

let _persistTimer = null;
function _persist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    try {
      const out = {};
      // Só guarda as ligadas (+ desligadas recentes, para não "religar" com
      // cache velho). Teto de 400 conversas.
      const rows = [..._map.entries()].sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 400);
      for (const [k, v] of rows) out[k] = { e: v.enabled ? 1 : 0, s: v.screenshotNotice !== false, t: v.at || 0 };
      require('./mmkv').setString?.(STORE_KEY, JSON.stringify(out));
    } catch {}
  }, 400);
}

function _emit(cid) {
  for (const cb of [..._subs]) { try { cb(cid); } catch {} }
}

function _truthy(v) {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

export function getAdvancedPrivacy(cid) {
  _hydrate();
  const k = _key(cid);
  if (!k) return { enabled: false, screenshotNotice: true, known: false };
  const v = _map.get(k);
  return v ? { enabled: !!v.enabled, screenshotNotice: v.screenshotNotice !== false, known: true } : { enabled: false, screenshotNotice: true, known: false };
}

export function isAdvancedPrivacyOn(cid) {
  return getAdvancedPrivacy(cid).enabled;
}

/** Grava o estado vindo do servidor/WS. `data` aceita advanced_privacy | enabled, screenshot_notice. */
export function noteAdvancedPrivacy(cid, data) {
  _hydrate();
  const k = _key(cid);
  if (!k || !data || typeof data !== 'object') return;
  const hasFlag = Object.prototype.hasOwnProperty.call(data, 'advanced_privacy') || Object.prototype.hasOwnProperty.call(data, 'enabled');
  if (!hasFlag) return;
  const raw = Object.prototype.hasOwnProperty.call(data, 'advanced_privacy') ? data.advanced_privacy : data.enabled;
  if (raw === null || raw === undefined) return; // servidor antigo / coluna ausente
  const enabled = _truthy(raw);
  const snRaw = data.screenshot_notice;
  const prev = _map.get(k);
  const screenshotNotice = (snRaw === null || snRaw === undefined) ? (prev ? prev.screenshotNotice !== false : true) : _truthy(snRaw);
  if (prev && prev.enabled === enabled && (prev.screenshotNotice !== false) === screenshotNotice) return;
  _map.set(k, { enabled, screenshotNotice, at: Date.now() });
  _persist();
  _emit(k);
}

export function subscribeAdvancedPrivacy(cb) {
  _subs.add(cb);
  _wireWs();
  return () => _subs.delete(cb);
}

/** React hook: { enabled, screenshotNotice, known } da conversa, ao vivo. */
export function useAdvancedPrivacy(cid) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const k = _key(cid);
    return subscribeAdvancedPrivacy((changed) => { if (!k || changed === k) force(); });
  }, [cid]);
  return getAdvancedPrivacy(cid);
}

// WS: o servidor manda `conversation_privacy` no canal pessoal de cada membro.
function _wireWs() {
  if (_wsWired) return;
  _wsWired = true;
  try {
    const ws = require('./websocket').default;
    ws?.on?.('conversation_privacy', (d) => {
      if (!d || d.conversation_id == null) return;
      noteAdvancedPrivacy(d.conversation_id, d);
    });
  } catch { _wsWired = false; }
  try {
    DeviceEventEmitter.addListener('chatyy:advPrivacy', (d) => {
      if (d && d.conversation_id != null) noteAdvancedPrivacy(d.conversation_id, d);
    });
  } catch {}
}

export async function fetchAdvancedPrivacy(cid) {
  const k = _key(cid);
  if (!k) return null;
  try {
    const api = require('./api');
    const r = await api.apiCall('chat_get_advanced_privacy', { conversation_id: Number(k) || k }, 'POST');
    if (r && r.success && r.data) { noteAdvancedPrivacy(k, r.data); return r.data; }
  } catch {}
  return null;
}

/** Liga/desliga para a conversa toda. Retorna { ok, error }. */
export async function setAdvancedPrivacyRemote(cid, enabled, screenshotNotice) {
  const k = _key(cid);
  if (!k) return { ok: false };
  const before = getAdvancedPrivacy(k);
  const sn = typeof screenshotNotice === 'boolean' ? screenshotNotice : before.screenshotNotice;
  // Otimista; desfaz se o servidor recusar.
  noteAdvancedPrivacy(k, { advanced_privacy: !!enabled, screenshot_notice: sn });
  try {
    const api = require('./api');
    const r = await api.apiCall('chat_set_advanced_privacy', {
      conversation_id: Number(k) || k, enabled: !!enabled, screenshot_notice: sn,
    }, 'POST');
    if (r && r.success) {
      if (r.data) noteAdvancedPrivacy(k, r.data);
      return { ok: true };
    }
    noteAdvancedPrivacy(k, { advanced_privacy: before.enabled, screenshot_notice: before.screenshotNotice });
    return { ok: false, error: (r && (r.error || r.message)) || '' };
  } catch (e) {
    noteAdvancedPrivacy(k, { advanced_privacy: before.enabled, screenshot_notice: before.screenshotNotice });
    return { ok: false, error: String((e && e.message) || '') };
  }
}

// ─── Aviso de print ────────────────────────────────────────────────────────
const _lastNotice = new Map(); // cid → ms
export function sendScreenshotNotice(cid, opts) {
  const k = _key(cid);
  if (!k) return;
  const now = Date.now();
  const last = _lastNotice.get(k) || 0;
  if (now - last < 8000) return; // rajada de prints = 1 aviso (servidor também limita)
  _lastNotice.set(k, now);
  // O visualizador de view-once já avisa (chat_screenshot_event) — não duplica.
  // Espera um instante: os dois listeners disparam no mesmo print.
  setTimeout(() => {
    try { if (Date.now() - (Number(globalThis.__chatyy_vo_shot_at) || 0) < 4000) return; } catch {}
    try {
      const api = require('./api');
      const r = api.apiCall('chat_screenshot_notice', {
        conversation_id: Number(k) || k,
        message_id: (opts && opts.messageId) ? opts.messageId : 0,
        kind: (opts && opts.kind) || 'screenshot',
      }, 'POST');
      if (r && r.catch) r.catch(() => {});
    } catch {}
  }, 450);
}

// ─── Proteção de captura (nativo) ──────────────────────────────────────────
let _SC; // expo-screen-capture | false
function _sc() {
  if (_SC !== undefined) return _SC || null;
  _SC = false;
  if (Platform.OS === 'web') return null;
  try { _SC = require('expo-screen-capture'); } catch { _SC = false; }
  return _SC || null;
}
let _CP; // modules/expo-chat-privacy | false
function _cp() {
  if (_CP !== undefined) return _CP || null;
  _CP = false;
  if (Platform.OS !== 'ios') return null;
  try {
    const m = require('../modules/expo-chat-privacy');
    if (m && typeof m.isAvailable === 'function' && m.isAvailable()) _CP = m;
  } catch { _CP = false; }
  return _CP || null;
}

/** iOS: escudo de gravação disponível neste binário? */
export function captureShieldAvailable() {
  return !!_cp();
}

/** iOS: a tela está sendo gravada/espelhada agora? (false sem o módulo) */
export function isScreenCaptured() {
  const m = _cp();
  return m ? m.isCaptured() : false;
}

export function addScreenCaptureListener(cb) {
  const m = _cp();
  return m ? m.addCaptureListener(cb) : { remove() {} };
}

/**
 * Liga a proteção de captura para `tag` (conversa/visualizador). Devolve a
 * função que desliga. opts: { labels: {title, subtitle}, iosSecureField }.
 *  Android → FLAG_SECURE (expo-screen-capture, contagem por tag).
 *  iOS → escudo na gravação (expo-chat-privacy). `iosSecureField` (só
 *        view-once, comportamento que já existia) mantém o preventScreenCapture
 *        do expo-screen-capture no iOS.
 */
export function acquireCaptureProtection(tag, opts) {
  const o = opts || {};
  let released = false;
  const sc = _sc();
  const useSc = !!sc && (Platform.OS === 'android' || (Platform.OS === 'ios' && o.iosSecureField));
  if (useSc) {
    try { sc.preventScreenCaptureAsync?.(tag)?.catch?.(() => {}); } catch {}
  }
  const cp = _cp();
  if (cp) cp.setShield(tag, true, o.labels || {});
  return () => {
    if (released) return;
    released = true;
    if (useSc) {
      try { sc.allowScreenCaptureAsync?.(tag)?.catch?.(() => {}); } catch {}
    }
    if (cp) cp.setShield(tag, false, o.labels || {});
  };
}

/** Listener de print (iOS sempre; Android 14+ quando o SO avisa). */
export function addScreenshotListener(cb) {
  const sc = _sc();
  if (!sc || typeof sc.addScreenshotListener !== 'function') return { remove() {} };
  try {
    const sub = sc.addScreenshotListener(() => { try { cb(); } catch {} });
    return { remove() { try { sub && sub.remove && sub.remove(); } catch {} } };
  } catch {
    return { remove() {} };
  }
}

// ─── Galeria ────────────────────────────────────────────────────────────────
export function markProtectedOpen(cid, open) {
  const k = _key(cid);
  if (!k) return;
  if (open) _openProtected.add(k); else _openProtected.delete(k);
}

/** true = NÃO salvar esta mídia na galeria automaticamente. */
export function isGalleryAutoSaveBlocked(cid) {
  const k = _key(cid);
  if (k) return isAdvancedPrivacyOn(k);
  return _openProtected.size > 0;
}
