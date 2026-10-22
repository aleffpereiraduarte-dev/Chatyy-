// services/followRequests.js — [privado 2026-10-22] Perfil privado nível Instagram.
// Estado compartilhado (Ajustes → Privacidade, meu perfil, Atividade, tela de pedidos):
//   { private: bool, pending: number } — cópia em disco (pinta na hora) + revalida no servidor.
// Servidor: profile_private_get/set, follow_request_list/respond/cancel, follower_remove.
import { useEffect, useState } from 'react';

const KEY = 'follow_req_state_v1';
let _state = null;
const _subs = new Set();

function _api() { try { return require('./api'); } catch { return null; } }
function _cache() { try { return require('./cache'); } catch { return null; } }

function _read() {
  if (_state) return _state;
  try {
    const c = _cache();
    const d = c && c.getCachedSync ? c.getCachedSync(c.userScopedKey ? c.userScopedKey(KEY) : KEY) : null;
    if (d && typeof d === 'object') _state = { private: !!d.private, pending: Number(d.pending) || 0 };
  } catch {}
  if (!_state) _state = { private: false, pending: 0, unknown: true };
  return _state;
}

function _set(patch) {
  const prev = _read();
  _state = { ...prev, ...patch, unknown: false };
  try {
    const c = _cache();
    if (c && c.setCache) c.setCache(c.userScopedKey ? c.userScopedKey(KEY) : KEY, { private: !!_state.private, pending: _state.pending }, 30 * 86400000).catch?.(() => {});
  } catch {}
  for (const fn of Array.from(_subs)) { try { fn(_state); } catch {} }
  return _state;
}

export function getFollowRequestState() { return _read(); }

export function subscribeFollowRequests(fn) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

let _inflight = null;
export function refreshFollowRequestState() {
  if (_inflight) return _inflight;
  const a = _api();
  if (!a || !a.profilePrivateGet) return Promise.resolve(_read());
  _inflight = a.profilePrivateGet().then((r) => {
    if (r && r.success && r.data) _set({ private: !!r.data.private, pending: Number(r.data.pending_count) || 0 });
    return _read();
  }).catch(() => _read()).finally(() => { _inflight = null; });
  return _inflight;
}

export function setPendingCount(n) { _set({ pending: Math.max(0, Number(n) || 0) }); }

/** Liga/desliga o perfil privado (otimista; erro volta). Retorna a resposta do servidor ou null. */
export async function setProfilePrivate(on) {
  const before = _read();
  _set({ private: !!on, pending: on ? before.pending : 0 });
  const a = _api();
  let r = null;
  try { r = a && a.profilePrivateSet ? await a.profilePrivateSet(!!on) : null; } catch { r = null; }
  if (!r || r.success === false) { _set({ private: before.private, pending: before.pending }); return null; }
  const d = r.data || {};
  _set({ private: !!d.private, pending: Number(d.pending_count) || 0 });
  return d;
}

/** Hook: { private, pending, unknown } sempre atual; revalida 1x ao montar. */
export function useFollowRequestState({ refresh = true } = {}) {
  const [st, setSt] = useState(_read);
  useEffect(() => {
    const off = subscribeFollowRequests(setSt);
    if (refresh) refreshFollowRequestState();
    return off;
  }, [refresh]);
  return st;
}
