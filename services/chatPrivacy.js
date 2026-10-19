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
//
// [2026-10-19 capmember] Proteção vinda de MEMBROS ("estou me protegendo"):
// o servidor manda em chat_info / histórico / chat_list / chat_get_advanced_privacy
//   adv_privacy_by_member, capture_protected_by_member, privacy_by_members[{email,name,adv}]
// = alguém da conversa ligou "Privacidade avançada em todas as conversas"
// (adv) ou "Bloquear capturas de tela nas conversas" (só captura). `enabled`
// abaixo passa a ser o EFETIVO (conversa OU membro OU o meu ajuste) — assim
// exportar/encaminhar/galeria/Bia seguem sozinhos; `convEnabled` = só o flag
// da conversa (o switch da folha). WS `conversation_privacy_member` → re-busca
// as conversas abertas.

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
          _map.set(k, { enabled: !!v.e, screenshotNotice: v.s !== false, at: Number(v.t) || 0, members: Array.isArray(v.m) ? v.m : [] });
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
      for (const [k, v] of rows) {
        out[k] = { e: v.enabled ? 1 : 0, s: v.screenshotNotice !== false, t: v.at || 0 };
        if (v.members && v.members.length) out[k].m = v.members.slice(0, 5);
      }
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

function _myEmail() {
  try { return String(require('./api').getActiveAccountEmail?.() || '').trim().toLowerCase(); } catch { return ''; }
}

function _myAdvDefault() {
  try { return !!require('./captureBlock').isAdvPrivacyDefault(); } catch { return false; }
}

// `_ver`: ignorado — versão do hook p/ o memo do React Compiler (useAdvancedPrivacy).
// [2026-10-19 capmember] enabled = EFETIVO; convEnabled = flag da conversa;
// memberAdv/memberCap/byName = outro membro protegendo; mineAdv = meu ajuste.
export function getAdvancedPrivacy(cid, _ver) {
  _hydrate();
  const k = _key(cid);
  const mineAdv = _myAdvDefault();
  const base = { enabled: false, convEnabled: false, screenshotNotice: true, known: false, memberAdv: false, memberCap: false, byName: '', byEmail: '', mineAdv: false };
  if (!k) return base;
  const v = _map.get(k);
  const me = _myEmail();
  const others = ((v && v.members) || []).filter((m) => m && m.email && String(m.email).toLowerCase() !== me);
  const advBy = others.find((m) => m.adv);
  const by = advBy || others[0] || null;
  const convEnabled = !!(v && v.enabled);
  const memberAdv = !!advBy;
  return {
    enabled: convEnabled || memberAdv || mineAdv,
    convEnabled,
    screenshotNotice: v ? v.screenshotNotice !== false : true,
    known: !!v,
    memberAdv,
    memberCap: others.length > 0,
    byName: by ? String(by.name || String(by.email).split('@')[0]) : '',
    byEmail: by ? String(by.email) : '',
    mineAdv,
  };
}

export function isAdvancedPrivacyOn(cid) {
  return getAdvancedPrivacy(cid).enabled;
}

/** Grava o estado vindo do servidor/WS. `data` aceita advanced_privacy | enabled, screenshot_notice. */
export function noteAdvancedPrivacy(cid, data) {
  _hydrate();
  const k = _key(cid);
  if (!k || !data || typeof data !== 'object') return;
  _noteMembers(k, data); // [2026-10-19 capmember]
  const hasFlag = Object.prototype.hasOwnProperty.call(data, 'advanced_privacy') || Object.prototype.hasOwnProperty.call(data, 'enabled');
  if (!hasFlag) return;
  const raw = Object.prototype.hasOwnProperty.call(data, 'advanced_privacy') ? data.advanced_privacy : data.enabled;
  if (raw === null || raw === undefined) return; // servidor antigo / coluna ausente
  const enabled = _truthy(raw);
  const snRaw = data.screenshot_notice;
  const prev = _map.get(k);
  const screenshotNotice = (snRaw === null || snRaw === undefined) ? (prev ? prev.screenshotNotice !== false : true) : _truthy(snRaw);
  if (prev && prev.enabled === enabled && (prev.screenshotNotice !== false) === screenshotNotice) return;
  _map.set(k, { enabled, screenshotNotice, at: Date.now(), members: (prev && prev.members) || [] });
  _persist();
  _emit(k);
}

// [2026-10-19 capmember] privacy_by_members do servidor → store (sem mexer no flag da conversa).
function _noteMembers(k, data) {
  const hasM = Array.isArray(data.privacy_by_members);
  const hasCap = Object.prototype.hasOwnProperty.call(data, 'capture_protected_by_member');
  if (!hasM && !hasCap) return; // servidor antigo
  const list = hasM
    ? data.privacy_by_members
      .filter((m) => m && m.email)
      .slice(0, 5)
      .map((m) => ({ email: String(m.email).toLowerCase(), name: String(m.name || ''), adv: _truthy(m.adv) }))
    : (_truthy(data.capture_protected_by_member) ? null : []);
  if (list === null) return; // flag sem lista: mantém o que tem
  const prev = _map.get(k);
  const prevList = (prev && prev.members) || [];
  if (JSON.stringify(prevList) === JSON.stringify(list)) return;
  _map.set(k, { enabled: !!(prev && prev.enabled), screenshotNotice: prev ? prev.screenshotNotice !== false : true, at: Date.now(), members: list });
  _persist();
  _emit(k);
}

// Conversas montadas agora (hook useAdvancedPrivacy) → re-busca no WS de membro.
const _mounted = new Map(); // cid → contagem
let _memberRefetchTimer = null;
function _onMemberEvent(d) {
  if (!d || !d.email) return;
  const em = String(d.email).toLowerCase();
  const adv = _truthy(d.adv);
  const cap = _truthy(d.cap) || adv;
  // Otimista nas conversas em que ele já aparece; as outras atualizam ao abrir.
  for (const [k, v] of _map) {
    const list = (v && v.members) || [];
    const i = list.findIndex((m) => m.email === em);
    if (i < 0) continue;
    const next = list.slice();
    if (!cap) next.splice(i, 1); else next[i] = { ...next[i], adv, name: d.name || next[i].name };
    _map.set(k, { ...v, members: next, at: Date.now() });
    _emit(k);
  }
  _persist();
  if (_memberRefetchTimer) clearTimeout(_memberRefetchTimer);
  _memberRefetchTimer = setTimeout(() => {
    _memberRefetchTimer = null;
    for (const k of _mounted.keys()) { try { fetchAdvancedPrivacy(k); } catch {} }
  }, 250 + Math.floor(Math.random() * 500));
}

export function subscribeAdvancedPrivacy(cb) {
  _subs.add(cb);
  _wireWs();
  return () => _subs.delete(cb);
}

/** React hook: { enabled, screenshotNotice, known } da conversa, ao vivo. */
export function useAdvancedPrivacy(cid) {
  // [2026-10-16 wave10-D compiler] A versão vai como ARGUMENTO: com o React
  // Compiler, `getAdvancedPrivacy(cid)` ficava memoizado só por `cid` e o
  // force() re-renderizava devolvendo o estado antigo (liga/desliga da
  // privacidade avançada não aparecia até remontar a tela).
  const [ver, force] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const k = _key(cid);
    if (k) _mounted.set(k, (_mounted.get(k) || 0) + 1);
    const un = subscribeAdvancedPrivacy((changed) => { if (!k || changed === k) force(); });
    // [2026-10-19 capmember] meu ajuste "Privacidade avançada em todas as conversas" (local).
    let un2 = null;
    try { un2 = require('./captureBlock').subscribeCaptureBlock(force); } catch {}
    return () => {
      un();
      try { un2 && un2(); } catch {}
      if (k) { const n = (_mounted.get(k) || 1) - 1; if (n > 0) _mounted.set(k, n); else _mounted.delete(k); }
    };
  }, [cid]);
  return getAdvancedPrivacy(cid, ver);
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
    ws?.on?.('conversation_privacy_member', _onMemberEvent); // [2026-10-19 capmember]
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
    noteAdvancedPrivacy(k, { advanced_privacy: before.convEnabled, screenshot_notice: before.screenshotNotice });
    return { ok: false, error: (r && (r.error || r.message)) || '' };
  } catch (e) {
    noteAdvancedPrivacy(k, { advanced_privacy: before.convEnabled, screenshot_notice: before.screenshotNotice });
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
      // [2026-10-19 secure-view] blocked = o print saiu com "Captura de tela
      // bloqueada" (iOS camada segura) → o outro lado vê "tentou fazer uma
      // captura de tela"; scope = por que a conversa está protegida ('global'
      // = ajuste "Bloquear capturas de tela nas conversas" de quem tirou).
      const r = api.apiCall('chat_screenshot_notice', {
        conversation_id: Number(k) || k,
        message_id: (opts && opts.messageId) ? opts.messageId : 0,
        kind: (opts && opts.kind) || 'screenshot',
        blocked: opts && opts.blocked ? 1 : 0,
        scope: (opts && opts.scope) || '',
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
  // [2026-10-15 screen-protect-all] Android: tag local no hub nativo — a
  // conversa protegida continua com FLAG_SECURE mesmo com a proteção do app
  // desligada (conta liberada / compartilhando a tela numa chamada).
  if (Platform.OS === 'android') {
    try { require('./screenProtect').setScreenProtectLocalTag?.(tag, true); } catch {}
  }
  // [2026-10-19 secure-view] iOS com <ChatyySecureView> (o.secureView): a
  // gravação já sai com "Captura de tela bloqueada" — sem a janela preta por
  // cima (o usuário continua vendo a própria tela, igual ao WhatsApp).
  let cp = _cp();
  if (cp && o.secureView) {
    try { if (require('./captureBlock').secureViewAvailable()) cp = null; } catch {}
  }
  if (cp) cp.setShield(tag, true, o.labels || {});
  return () => {
    if (released) return;
    released = true;
    if (useSc) {
      try { sc.allowScreenCaptureAsync?.(tag)?.catch?.(() => {}); } catch {}
    }
    // Depois do allow do expo (que limpa o FLAG_SECURE da Activity): solta a
    // tag local e re-aplica a proteção do app inteiro.
    if (Platform.OS === 'android') {
      try { require('./screenProtect').setScreenProtectLocalTag?.(tag, false); } catch {}
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
