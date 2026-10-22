// [e2ee5 rollout §5 2026-10-22] "Atualize para continuar nesta conversa".
//
// Conversa e2ee_mode=1 + app que NÃO consegue cifrar (flag __chatyy_e2ee5 desligada, ou ligada sem o
// núcleo nativo chatyy-crypto no binário) → o composer some e entra o aviso + botão da loja. Nada em
// claro sai do aparelho: o relay WS (services/websocket.js) também consulta knownE2ee().
//
// De onde vem o modo (o chat_list NÃO traz e2ee_mode):
//   1. e2ee5.convModeSync (flag ligada: e2ee5_conversation_state);
//   2. recusa do servidor 409 e2ee5_plaintext_refused (chat_send HTTP/hub, dreno regional) ou o
//      message_ack {refused} do relay no hub — sinal definitivo;
//   3. histórico carregado: marcador {"sys":"e2ee_on"|"e2ee_off"} ou envelope {"e2e":…} mais novo.
// Kill (OTA): globalThis.__chatyy_e2ee5_update_gate = false.
import { Platform, Linking } from 'react-native';

const _mode = new Map(); // cid → {mode, src, at}
const _subs = new Map(); // cid → Set(cb)
const MAX = 500;

function _g() { return typeof globalThis !== 'undefined' ? globalThis : global; }
function _off() { try { return _g().__chatyy_e2ee5_update_gate === false; } catch (_) { return false; } }
function _E() { try { return require('./e2ee5'); } catch (_) { return null; } }

/** Núcleo nativo carregado (módulo no binário + API + coreLinked). Web: o núcleo é o WASM da vinculada. */
export function coreLinked() {
  if (Platform.OS === 'web') return true;
  try {
    const m = require('../../modules/expo-chatyy-crypto');
    if (m && typeof m.isNativeAvailable === 'function') return m.isNativeAvailable() === true;
  } catch (_) {}
  return false;
}

/** Este app consegue mandar mensagem cifrada (E2EE v5) agora. */
export function capable() {
  const e = _E();
  return !!(e && e.isOn() && coreLinked());
}

function _emit(cid) {
  const set = _subs.get(cid);
  if (!set) return;
  const v = needsUpdate(cid);
  for (const cb of Array.from(set)) { try { cb(v); } catch (_) {} }
}

function _set(cid, mode, src) {
  if (cid == null || cid === '') return;
  const k = String(cid);
  const prev = _mode.get(k);
  // recusa do servidor vale mais que a dedução pelo histórico
  if (prev && prev.src === 'refused' && src === 'history' && mode === 0) return;
  if (prev && prev.mode === mode && prev.src === src) return;
  const was = needsUpdate(k);
  _mode.set(k, { mode, src, at: Date.now() });
  if (_mode.size > MAX) _mode.delete(_mode.keys().next().value);
  if (needsUpdate(k) !== was) _emit(k);
}

/** 1 = cifrada, 0 = normal, null = não sei. */
export function modeOf(cid) {
  if (cid == null) return null;
  const k = String(cid);
  try {
    const e = _E();
    if (e && e.isOn()) { const m = e.convModeSync(k); if (m === 0 || m === 1) return m; }
  } catch (_) {}
  const s = _mode.get(k);
  return s ? s.mode : null;
}

/** A conversa é sabidamente cifrada (para o relay não mandar texto). */
export function knownE2ee(cid) { return modeOf(cid) === 1; }

/** Mostrar "Atualize para continuar nesta conversa" no lugar do composer. */
export function needsUpdate(cid) {
  if (_off() || cid == null) return false;
  return modeOf(cid) === 1 && !capable();
}

/** Resultado de chat_send (HTTP/hub/Rust) ou frame chat_send_rejected / message_ack do relay. */
export function noteResult(cid, r) {
  try {
    if (!r) return;
    const d = r.data && typeof r.data === 'object' ? r.data : {};
    const code = String(r.code || d.code || r.refused || r.error || '');
    if (code === 'e2ee5_plaintext_refused') _set(cid != null ? cid : (d.conversation_id || r.conversation_id), 1, 'refused');
  } catch (_) {}
}

function _sysKind(c) {
  if (typeof c !== 'string' || c.charAt(0) !== '{') return null;
  if (c.startsWith('{"sys":"e2ee_on"')) return 'on';
  if (c.startsWith('{"sys":"e2ee_off"')) return 'off';
  try { const o = JSON.parse(c); if (o && o.sys === 'e2ee_on') return 'on'; if (o && o.sys === 'e2ee_off') return 'off'; } catch (_) {}
  return null;
}

/** Histórico carregado (ordem qualquer): o marcador/envelope mais novo decide. */
export function noteMessages(cid, list) {
  if (cid == null || !Array.isArray(list) || !list.length) return;
  try {
    let best = null; let bestKey = -Infinity; let mode = null;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const c = typeof m._e2eRaw === 'string' ? m._e2eRaw : m.content;
      const raw = typeof m.content === 'string' ? m.content : '';
      let v = null;
      const sk = _sysKind(raw) || _sysKind(c);
      if (sk === 'on') v = 1; else if (sk === 'off') v = 0;
      else if ((typeof c === 'string' && c.startsWith('{"e2e":')) || m._e2e === true || m._e5State) v = 1;
      if (v == null) continue;
      if (typeof m.id === 'string' && m.id.startsWith('tmp_')) continue; // eco local não decide
      const key = Number(m.id) || Date.parse(m.created_at || '') || 0;
      if (best == null || key >= bestKey) { best = m; bestKey = key; mode = v; }
    }
    if (mode != null) _set(cid, mode, 'history');
  } catch (_) {}
}

/** Assina mudanças de needsUpdate(cid). → cancelar. */
export function watch(cid, cb) {
  if (cid == null || typeof cb !== 'function') return () => {};
  const k = String(cid);
  let set = _subs.get(k);
  if (!set) { set = new Set(); _subs.set(k, set); }
  set.add(cb);
  let offE5 = null;
  try { const e = _E(); if (e && e.isOn()) offE5 = e.watchConversation(k, () => _emit(k)); } catch (_) {}
  return () => { try { set.delete(cb); if (!set.size) _subs.delete(k); if (offE5) offE5(); } catch (_) {} };
}

export const STORE_URL = Platform.OS === 'ios'
  ? 'itms-apps://apps.apple.com/app/id6759975575'
  : 'market://details?id=com.onemundo.mail';
const STORE_WEB = Platform.OS === 'ios'
  ? 'https://apps.apple.com/app/id6759975575'
  : 'https://play.google.com/store/apps/details?id=com.onemundo.mail';

export function openStore() {
  if (Platform.OS === 'web') return;
  Linking.openURL(STORE_URL).catch(() => { Linking.openURL(STORE_WEB).catch(() => {}); });
}

export default { coreLinked, capable, modeOf, knownE2ee, needsUpdate, noteResult, noteMessages, watch, openStore, STORE_URL };
