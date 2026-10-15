// useCachedAction — tela offline-first (stale-while-revalidate PERSISTENTE).
//
// [2026-10-14 offline-first] Founder: "as páginas deveriam abrir mais rápido —
// tudo que tem que estar salvo no celular da pessoa". Mecanismo ÚNICO para as
// telas principais, em cima de services/cache.js (MMKV hidratado em memória
// no boot no native / localStorage no web; chave escopada pela conta ativa via
// setCacheUser — nunca mistura contas; sem conta = não lê nem grava):
//
//   const { data, loading, refreshing, offline, refresh, setData } =
//     useCachedAction(['wallet', 'balance'], async () => {
//       const r = await api.walletBalance();
//       return r?.success ? r.data : undefined;   // undefined = falhou → não grava
//     }, { ttl: 60_000 });
//
//   1º render: lê o último valor salvo de forma SÍNCRONA (data já preenchido,
//   loading=false) → a tela pinta na hora, sem skeleton.
//   Depois: se não há cópia ou ela tem mais de `ttl`, busca em 2º plano
//   (refreshing=true só como sinal discreto), grava e atualiza.
//   Falha de rede com cópia na tela: mantém a cópia (offline=true).
//   Cópia com mais de `maxAge` (7 dias) é ignorada.
//
// Também: prefetchCached(key, fetcher, opts) para aquecer telas em 2º plano,
// peekCached(key) para leitura síncrona fora de componente.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCachedEntrySync, setCache, hasCacheUser, cacheUserScope, invalidate } from '../services/cache';

const DAY = 24 * 3600 * 1000;
export const CACHED_MAX_AGE = 7 * DAY;
const PFX = 'sc1:';

export function cachedKey(key) {
  if (key == null || key === false) return null;
  if (Array.isArray(key)) {
    try { return PFX + key.map((p) => (p && typeof p === 'object' ? JSON.stringify(p) : String(p ?? ''))).join(':'); } catch { return null; }
  }
  return PFX + String(key);
}

const _inflight = new Map(); // scope|key -> Promise<value|undefined>
const _listeners = new Map(); // key -> Set<fn(value, ts)>

function _emit(k, v, ts) {
  const set = _listeners.get(k);
  if (!set) return;
  for (const fn of Array.from(set)) { try { fn(v, ts); } catch {} }
}

/** Valor salvo (síncrono) — ou null. */
export function peekCached(key, maxAge = CACHED_MAX_AGE) {
  const k = cachedKey(key);
  if (!k || !hasCacheUser()) return null;
  const e = getCachedEntrySync(k, maxAge);
  return e ? e.data : null;
}

/** Grava o valor (tela que buscou por conta própria / alteração otimista). */
export function putCached(key, value) {
  const k = cachedKey(key);
  if (!k || value === undefined || !hasCacheUser()) return;
  const ts = Date.now();
  setCache(k, value, CACHED_MAX_AGE);
  _emit(k, value, ts);
}

export function dropCached(key) {
  const k = cachedKey(key);
  if (k) { try { invalidate(k); } catch {} }
}

function _isOfflineNow() {
  try { if (typeof navigator !== 'undefined' && navigator.onLine === false) return true; } catch {}
  return false;
}

// Busca deduplicada; grava só se a conta não mudou durante o voo.
function _fetchAndStore(k, fetcher) {
  const scope = cacheUserScope();
  if (!scope) return Promise.resolve(undefined);
  const fk = scope + '|' + k;
  const cur = _inflight.get(fk);
  if (cur) return cur;
  const p = (async () => {
    let v;
    try { v = await fetcher(); } catch { v = undefined; }
    if (v === undefined || (v && typeof v === 'object' && v._offline)) return undefined;
    if (cacheUserScope() !== scope) return undefined; // trocou de conta no meio → descarta
    const ts = Date.now();
    setCache(k, v, CACHED_MAX_AGE);
    _emit(k, v, ts);
    return v;
  })().finally(() => { _inflight.delete(fk); });
  _inflight.set(fk, p);
  return p;
}

/**
 * Aquece uma tela em 2º plano. Pula se a cópia salva tem menos de `ttl`.
 * Retorna o valor (salvo ou novo) ou undefined.
 */
export async function prefetchCached(key, fetcher, { ttl = 5 * 60 * 1000 } = {}) {
  const k = cachedKey(key);
  if (!k || !hasCacheUser() || typeof fetcher !== 'function') return undefined;
  const e = getCachedEntrySync(k, CACHED_MAX_AGE);
  if (e && Date.now() - e.ts < ttl) return e.data;
  return _fetchAndStore(k, fetcher);
}

function _init(k, maxAge, initial) {
  const e = k && hasCacheUser() ? getCachedEntrySync(k, maxAge) : null;
  return { k, data: e ? e.data : initial, ts: e ? e.ts : 0, fromCache: !!e };
}

export default function useCachedAction(key, fetcher, opts = {}) {
  const { ttl = 30 * 1000, maxAge = CACHED_MAX_AGE, enabled = true, initial = null } = opts;
  const k = enabled ? cachedKey(key) : null;
  const [st, setSt] = useState(() => _init(k, maxAge, initial));
  let state = st;
  if (st.k !== k) { state = _init(k, maxAge, initial); setSt(state); } // chave mudou → cópia da nova chave já neste render
  const [busy, setBusy] = useState(false);
  const [doneK, setDoneK] = useState(null); // chave cuja 1ª busca já terminou
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Outras instâncias / prefetch atualizam esta tela.
  useEffect(() => {
    if (!k) return undefined;
    const fn = (v, ts) => { if (mounted.current) setSt((s) => (s.k === k ? { k, data: v, ts, fromCache: false } : s)); };
    let set = _listeners.get(k);
    if (!set) { set = new Set(); _listeners.set(k, set); }
    set.add(fn);
    return () => { set.delete(fn); if (!set.size) _listeners.delete(k); };
  }, [k]);

  const run = useCallback(async () => {
    if (!k) return undefined;
    setBusy(true);
    try {
      const v = await _fetchAndStore(k, () => fetcherRef.current && fetcherRef.current());
      if (!mounted.current) return v;
      if (v === undefined) {
        setOffline(_isOfflineNow());
        setError(_isOfflineNow() ? 'offline' : 'failed');
      } else {
        setOffline(false); setError(null);
      }
      return v;
    } finally {
      if (mounted.current) { setBusy(false); setDoneK(k); }
    }
  }, [k]);

  useEffect(() => {
    if (!k) return;
    const age = state.ts ? Date.now() - state.ts : Infinity;
    if (!state.fromCache || age >= ttl) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);

  const setData = useCallback((next) => {
    setSt((s) => {
      const v = typeof next === 'function' ? next(s.data) : next;
      if (s.k && v !== undefined && hasCacheUser()) setCache(s.k, v, CACHED_MAX_AGE);
      return { ...s, data: v, ts: Date.now() };
    });
  }, []);

  const hasData = state.data !== null && state.data !== undefined && state.data !== initial;
  return {
    data: state.data,
    setData,
    // loading = sem nada para mostrar ainda (só aí a tela usa skeleton/spinner)
    loading: !!k && !(state.fromCache || hasData) && (busy || doneK !== k),
    // refreshing = há dado na tela e uma revalidação discreta em curso
    refreshing: busy && (state.fromCache || hasData),
    fromCache: state.fromCache,
    cachedAt: state.ts,
    offline,
    error,
    refresh: run,
  };
}
