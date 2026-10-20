// [viewers 2026-10-20] Cache de "Visualizações" (quem viu) do PRÓPRIO status.
//
// Antes: cada abertura da folha buscava status_viewers do zero (spinner até a
// resposta; em LTE com o edge EU/US no meio = 0,6-1 s, e se a busca silenciosa
// falhava/pendurava o spinner nativo ficava girando p/ sempre). Agora (WhatsApp):
//   • cache por status (memória + mmkv, por conta, 48 h, 60 status) → a folha
//     pinta NA HORA com a última lista conhecida e atualiza por trás;
//   • pré-busca ao exibir o próprio status e ao tocar no contador;
//   • 1 busca em voo por status (dedupe), prazo de 8 s + 1 nova tentativa;
//   • nomes vêm na MESMA resposta (servidor faz JOIN em chat_display_names) e o
//     avatar usa a URL canônica (mesmo cache de imagem da lista) — sem N+1.
// Kill switch (OTA/console): globalThis.__chatyy_viewers_cache = false.
import * as api from './api';

const KEY_PREFIX = 'status_viewers_v1:';
const MAX_ENTRIES = 60;
const MAX_AGE_MS = 48 * 3600 * 1000;
const TIMEOUT_MS = 8000;

const _mem = new Map(); // id → { viewers, count, blocked, at }
const _inflight = new Map(); // id → Promise
let _loadedFor = null;
let _persistTimer = null;

function _off() { try { return globalThis.__chatyy_viewers_cache === false; } catch { return false; } }
function _account() { try { return String(api.getAvatarViewerEmail?.() || api.getSavedEmail?.() || '').toLowerCase(); } catch { return ''; } }
function _kv() { try { return require('./mmkv'); } catch { return null; } }

function _hydrate() {
  const acc = _account();
  if (_loadedFor === acc) return;
  _mem.clear();
  _loadedFor = acc;
  if (!acc) return;
  try {
    const kv = _kv();
    const raw = kv && kv.getJSON ? kv.getJSON(KEY_PREFIX + acc) : null;
    if (raw && typeof raw === 'object') {
      const now = Date.now();
      for (const id of Object.keys(raw)) {
        const e = raw[id];
        if (e && Array.isArray(e.viewers) && (now - (Number(e.at) || 0)) < MAX_AGE_MS) _mem.set(String(id), e);
      }
    }
  } catch {}
}

function _persistSoon() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    const acc = _loadedFor;
    if (!acc) return;
    try {
      const entries = Array.from(_mem.entries()).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_ENTRIES);
      const out = {};
      for (const [id, e] of entries) out[id] = { viewers: e.viewers.slice(0, 200), count: e.count, blocked: !!e.blocked, at: e.at };
      const kv = _kv();
      if (kv && kv.setJSON) kv.setJSON(KEY_PREFIX + acc, out);
    } catch {}
  }, 400);
}

/** Última lista conhecida (síncrono, zero I/O depois do 1º acesso) ou null. */
export function getCachedStatusViewers(statusId) {
  if (_off() || statusId == null) return null;
  _hydrate();
  return _mem.get(String(statusId)) || null;
}

function _store(id, viewers, count, blocked) {
  _hydrate();
  const e = { viewers, count, blocked: !!blocked, at: Date.now() };
  _mem.set(String(id), e);
  _persistSoon();
  return e;
}

function _withTimeout(p, ms) {
  let t = null;
  return Promise.race([
    p,
    new Promise((resolve) => { t = setTimeout(() => resolve({ success: false, message: 'Tempo limite excedido', __viewersTimeout: true }), ms); }),
  ]).finally(() => { if (t) clearTimeout(t); });
}

async function _once(id) {
  const r = await _withTimeout(api.statusViewers(id), TIMEOUT_MS);
  if (!r || r.success === false) return null;
  const d = r.data || {};
  const viewers = Array.isArray(d.viewers) ? d.viewers : (Array.isArray(d) ? d : null);
  if (!viewers) return null;
  const n = Number(d.count ?? d.total ?? viewers.length);
  return _store(id, viewers, Number.isFinite(n) ? n : viewers.length, d.blocked);
}

/**
 * Busca (com dedupe) e grava no cache. Resolve a entrada { viewers, count, at }
 * ou null se falhou (2 tentativas). Nunca rejeita.
 */
export function fetchStatusViewers(statusId) {
  if (statusId == null || statusId === '') return Promise.resolve(null);
  const id = String(statusId);
  const ex = _inflight.get(id);
  if (ex) return ex;
  const p = (async () => {
    try {
      let e = await _once(id).catch(() => null);
      if (!e) {
        await new Promise(res => setTimeout(res, 600));
        e = await _once(id).catch(() => null);
      }
      return e;
    } finally {
      if (_inflight.get(id) === p) _inflight.delete(id);
    }
  })();
  _inflight.set(id, p);
  return p;
}

/** Pré-busca se o cache estiver mais velho que maxAgeMs (padrão 10 s). */
export function prefetchStatusViewers(statusId, maxAgeMs = 10000) {
  if (statusId == null || statusId === '') return;
  const c = getCachedStatusViewers(statusId);
  if (c && (Date.now() - (c.at || 0)) < maxAgeMs) return;
  fetchStatusViewers(statusId);
}

export function invalidateStatusViewers(statusId) {
  if (statusId == null) return;
  _hydrate();
  _mem.delete(String(statusId));
  _persistSoon();
}
