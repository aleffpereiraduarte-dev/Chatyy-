// [2026-10-22 stalecall] "Tocou sem parar" com rede ruim (call_1792672771124_ah9s2jvah,
// founder em Santiago): o fim da ligação chegou tarde/nunca e convites repetidos da MESMA
// ligação foram ponteados 2× ao nativo. Este módulo é a trava única do JS para todo caminho
// de convite (WS JS → ponte nativa, fila offline do WS, re-envio do toque):
//   - cache local de ligações ENCERRADAS (call_end/cancel/declined/missed/dismissed recebidos
//     ou fim local), em memória + AsyncStorage (sobrevive a reload do JS), TTL 10 min;
//   - idade do convite (replay_age_ms do hub → server_ts → epoch do call_id do caller);
//   - dedupe por call_id da ponte JS→nativo;
//   - consulta rápida ao servidor (call_status status=query, só leitura) antes de tocar um
//     convite velho com o app em 2º plano.
// Nunca lança. Kill: globalThis.__chatyy_stalecall_off = true.
import { Platform } from 'react-native';

const ENDED_TTL_MS = 10 * 60 * 1000;
const ENDED_MAX = 200;
const STORE_KEY = 'chatyy_call_ended_v1';
export const INVITE_RING_MAX_MS = 45 * 1000;
// Convite "velho": acima disto, com o app em 2º plano, pergunta ao servidor antes de tocar.
export const INVITE_CHECK_SERVER_MS = 15 * 1000;
const CALL_ID_MAX_AGE_MS = 90 * 1000; // epoch do call_id = relógio do CALLER (tolerância maior)
const SERVER_TS_SKEW_MS = 15 * 1000;  // server_ts = relógio do servidor vs relógio deste aparelho
const BRIDGE_DEDUPE_MS = 120 * 1000;

const _ended = new Map(); // callId -> { at, reason }
const _bridged = new Map(); // callId -> { at, named }
let _loaded = false;
let _loading = null;
let _saveTimer = null;

export function staleGuardOff() {
  try { return globalThis.__chatyy_stalecall_off === true; } catch { return false; }
}

function _key(callId) {
  return String(callId || '').trim();
}

function _prune(now) {
  for (const [k, v] of _ended) { if (!v || now - v.at > ENDED_TTL_MS) _ended.delete(k); }
  while (_ended.size > ENDED_MAX) { const first = _ended.keys().next().value; _ended.delete(first); }
  for (const [k, v] of _bridged) { if (!v || now - v.at > BRIDGE_DEDUPE_MS) _bridged.delete(k); }
}

function _storage() {
  if (Platform.OS === 'web') return null;
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}

/** Carrega o cache persistido (1×). Seguro chamar várias vezes. */
export function loadEndedCache() {
  if (_loaded) return Promise.resolve();
  if (_loading) return _loading;
  const AS = _storage();
  if (!AS) { _loaded = true; return Promise.resolve(); }
  _loading = AS.getItem(STORE_KEY).then((raw) => {
    try {
      const obj = raw ? JSON.parse(raw) : null;
      if (obj && typeof obj === 'object') {
        const now = Date.now();
        for (const k of Object.keys(obj)) {
          const at = Number(obj[k]?.at || obj[k]);
          if (Number.isFinite(at) && now - at <= ENDED_TTL_MS && !_ended.has(k)) {
            _ended.set(k, { at, reason: String(obj[k]?.reason || 'stored') });
          }
        }
      }
    } catch {}
  }).catch(() => {}).finally(() => { _loaded = true; _loading = null; });
  return _loading;
}

function _scheduleSave() {
  const AS = _storage();
  if (!AS || _saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      _prune(Date.now());
      const out = {};
      for (const [k, v] of _ended) out[k] = { at: v.at, reason: v.reason };
      AS.setItem(STORE_KEY, JSON.stringify(out)).catch(() => {});
    } catch {}
  }, 400);
}

/** Marca a ligação como encerrada NESTE aparelho (qualquer caminho). */
export function noteCallEnded(callId, reason = '') {
  const k = _key(callId);
  if (!k) return;
  try {
    const now = Date.now();
    if (!_ended.has(k)) _ended.set(k, { at: now, reason: String(reason || '') });
    _prune(now);
    _scheduleSave();
  } catch {}
}

export function isCallEnded(callId) {
  const k = _key(callId);
  if (!k || staleGuardOff()) return false;
  const v = _ended.get(k);
  if (!v) return false;
  if (Date.now() - v.at > ENDED_TTL_MS) { _ended.delete(k); return false; }
  return true;
}

/** Epoch (ms) embutido no call_id `call_<13 dígitos>_<rand>` — relógio do caller. */
export function callIdAgeMs(callId) {
  const m = /^call_(\d{13})_/.exec(String(callId || ''));
  if (!m) return 0;
  const age = Date.now() - Number(m[1]);
  return Number.isFinite(age) ? age : 0;
}

/**
 * Melhor estimativa da idade do convite (ms) e a fonte. Ordem de confiança:
 * replay_age_ms (calculado no servidor) → server_ts (relógio do servidor, desconta
 * SERVER_TS_SKEW_MS) → call_id (relógio do caller, só como teto grosso).
 */
export function inviteAge(data) {
  try {
    const r = Number(data?.replay_age_ms);
    if (Number.isFinite(r) && r > 0) return { ms: r, src: 'replay_age' };
    const st = Number(data?.server_ts);
    if (Number.isFinite(st) && st > 0) {
      const a = Date.now() - st;
      if (Math.abs(a) < 6 * 3600 * 1000) return { ms: Math.max(0, a - SERVER_TS_SKEW_MS), src: 'server_ts' };
    }
    const c = callIdAgeMs(data?.call_id || data?.room_id);
    if (c > 0 && c < 6 * 3600 * 1000) return { ms: Math.max(0, c - (CALL_ID_MAX_AGE_MS - INVITE_RING_MAX_MS)), src: 'call_id' };
  } catch {}
  return { ms: 0, src: '' };
}

/** '' = pode tocar; senão o motivo para NUNCA tocar (convite morto). */
export function inviteStaleReason(data) {
  if (staleGuardOff()) return '';
  try {
    const r = Number(data?.replay_age_ms);
    if (Number.isFinite(r) && r > INVITE_RING_MAX_MS) return 'replay_age';
    const st = Number(data?.server_ts);
    if (Number.isFinite(st) && st > 0) {
      const a = Date.now() - st;
      if (a > INVITE_RING_MAX_MS + SERVER_TS_SKEW_MS && a < 6 * 3600 * 1000) return 'server_ts';
    }
    if (callIdAgeMs(data?.call_id || data?.room_id) > CALL_ID_MAX_AGE_MS) return 'call_id_age';
  } catch {}
  return '';
}

/**
 * Dedupe da ponte JS→nativo por call_id. true = encaminhar. Um 2º frame só passa se o
 * 1º veio SEM nome e este traz o nome (o nativo atualiza o CallKit que já toca).
 */
export function claimBridge(callId, hasName) {
  const k = _key(callId);
  if (!k) return false;
  if (staleGuardOff()) return true;
  const now = Date.now();
  _prune(now);
  const prev = _bridged.get(k);
  if (!prev) { _bridged.set(k, { at: now, named: !!hasName }); return true; }
  if (!prev.named && hasName) { prev.named = true; return true; }
  return false;
}

/**
 * Estado da ligação no servidor (call_status status=query, só leitura). Resolve com
 * { known, terminal, answered, ringing, state } ou null (sem resposta em timeoutMs /
 * erro / servidor antigo). Nunca rejeita.
 */
export function serverCallState(callId, timeoutMs = 2500) {
  const k = _key(callId);
  if (!k) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => fin(null), Math.max(500, timeoutMs));
    try {
      const api = require('./api');
      const p = api.apiCall('call_status', { call_id: k, status: 'query' }, 'POST');
      Promise.resolve(p).then((r) => {
        clearTimeout(t);
        const d = r && typeof r === 'object' ? (r.data && typeof r.data === 'object' ? r.data : r) : null;
        if (!d || typeof d.terminal !== 'boolean') { fin(null); return; }
        fin({
          known: !!d.known,
          terminal: !!d.terminal,
          answered: !!d.answered,
          ringing: d.ringing === true,
          state: String(d.state || ''),
        });
      }, () => { clearTimeout(t); fin(null); });
    } catch { clearTimeout(t); fin(null); }
  });
}

let _wsSubscribed = false;
/**
 * Alimenta o cache com todo fim de ligação que o WS JS receber. Idempotente.
 * (call_dismissed = atendida/recusada em outro aparelho: este não deve tocar de novo.)
 */
export function subscribeWsCallEnds() {
  if (_wsSubscribed) return;
  try {
    const mailWs = require('./websocket').default;
    if (!mailWs?.on) return;
    _wsSubscribed = true;
    for (const ev of ['call_end', 'call_cancel', 'call_declined', 'call_rejected', 'call_missed', 'call_dismissed']) {
      mailWs.on(ev, (d) => {
        try {
          const id = d?.call_id || d?.room_id || d?.data?.call_id || '';
          if (id) noteCallEnded(id, 'ws_' + ev + (d?.reason ? ':' + d.reason : ''));
        } catch {}
      });
    }
  } catch {}
}

export default {
  noteCallEnded, isCallEnded, inviteAge, inviteStaleReason, claimBridge, serverCallState,
  subscribeWsCallEnds, loadEndedCache, callIdAgeMs, INVITE_RING_MAX_MS, INVITE_CHECK_SERVER_MS,
};
