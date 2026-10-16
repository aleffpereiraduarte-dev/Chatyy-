// components/calls/myCallLinks.js — [2026-10-16 wave12-D] "Meus links de chamada".
//
// Guardamos no aparelho os links criados aqui — no cache POR CONTA
// (services/cache prefixa o e-mail logado → nunca vaza entre contas) — e, ao
// abrir a folha, sincronizamos com o servidor: [wave13e 2026-10-16]
// `chat_call_links_list` (até 50 do criador, de QUALQUER aparelho) é mesclado
// com o cache (servidor manda no estado; links só-locais ficam). Servidor
// antigo/sem rede → confere 1 a 1 com `chat_call_link_info` (como antes).
// "Remover da lista" é local: o id vai para uma lista de ocultos para não
// voltar na próxima sincronização.
//
// Registro: { link_id, url, is_video, created_at (ms), expires_at (ms), revoked }
// Links mortos há mais de 30 dias saem sozinhos; teto de 50 entradas.

import { useEffect, useState } from 'react';

const KEY = 'my_call_links_v1';
const HIDDEN_KEY = 'my_call_links_hidden_v1'; // [wave13e] removidos à mão (não voltam do servidor)
const MAX = 50;
const KEEP_DEAD_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_TTL_MS = 24 * 3600 * 1000; // servidor: expiry padrão 24h

const _listeners = new Set();

function _read() {
  try {
    const { getCachedSync } = require('../../services/cache');
    const v = getCachedSync(KEY);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function _prune(list) {
  const now = Date.now();
  return list
    .filter((l) => l && l.link_id && l.url)
    .filter((l) => {
      const deadAt = l.revoked ? (l.revoked_at || l.created_at || 0) : (l.expires_at || 0);
      return !(deadAt && now - deadAt > KEEP_DEAD_MS && (l.revoked || deadAt < now));
    })
    .slice(0, MAX);
}

function _write(list) {
  const next = _prune(list);
  try { require('../../services/cache').setCache(KEY, next); } catch {}
  _listeners.forEach((fn) => { try { fn(next); } catch {} });
  return next;
}

export function getMyCallLinks() { return _prune(_read()); }

export function addMyCallLink({ link_id, url, is_video }) {
  if (!link_id || !url) return;
  const now = Date.now();
  const rest = _read().filter((l) => l && l.link_id !== link_id);
  _write([{ link_id, url, is_video: !!is_video, created_at: now, expires_at: now + DEFAULT_TTL_MS, revoked: false }, ...rest]);
}

export function patchMyCallLink(linkId, patch) {
  _write(_read().map((l) => (l && l.link_id === linkId ? { ...l, ...patch } : l)));
}

function _hidden() {
  try {
    const v = require('../../services/cache').getCachedSync(HIDDEN_KEY);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function removeMyCallLink(linkId) {
  try {
    const h = _hidden().filter((x) => x !== linkId);
    require('../../services/cache').setCache(HIDDEN_KEY, [linkId, ...h].slice(0, 200));
  } catch {}
  _write(_read().filter((l) => l && l.link_id !== linkId));
}

// [wave13e] Mescla a lista do servidor com o cache local. Servidor manda no
// estado (revogado/expirado/esgotado, datas); entradas só-locais ficam.
function _mergeServer(items) {
  const hidden = new Set(_hidden());
  const local = _read();
  const byId = new Map(local.filter((l) => l && l.link_id).map((l) => [l.link_id, l]));
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const id = it && String(it.link_id || '');
    if (!id || hidden.has(id) || seen.has(id)) continue;
    seen.add(id);
    const prev = byId.get(id) || {};
    const st = String(it.state || '');
    out.push({
      ...prev,
      link_id: id,
      url: it.url || prev.url || `https://chatyy.com.br/call/${id}`,
      is_video: !!it.is_video,
      created_at: Number(it.created_at) || prev.created_at || 0,
      expires_at: it.expires_at == null ? 0 : Number(it.expires_at) || 0,
      revoked: !!it.revoked || st === 'revoked',
      revoked_at: Number(it.revoked_at) || prev.revoked_at || undefined,
      expired: st === 'expired' || st === 'exhausted',
      uses: Number(it.uses) || 0,
      max_uses: it.max_uses == null ? null : Number(it.max_uses) || null,
    });
  }
  for (const l of local) if (l && l.link_id && !seen.has(l.link_id) && !hidden.has(l.link_id)) out.push(l);
  out.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
  _write(out);
}

export function callLinkState(l, now = Date.now()) {
  if (!l) return 'expired';
  if (l.revoked) return 'revoked';
  if (l.expired || (l.expires_at && l.expires_at <= now)) return 'expired';
  return 'active';
}

export function useMyCallLinks() {
  const [list, setList] = useState(getMyCallLinks);
  useEffect(() => {
    _listeners.add(setList);
    setList(getMyCallLinks());
    return () => { _listeners.delete(setList); };
  }, []);
  return list;
}

// Confere com o servidor os links ainda "ativos" localmente (revogado em outro
// aparelho / expirado). Silencioso: falha de rede mantém o estado local.
export async function refreshMyCallLinks() {
  let api;
  try { api = require('../../services/api'); } catch { return; }
  // [wave13e 2026-10-16] Lista do servidor (links criados em qualquer aparelho).
  try {
    const r = await api.apiCall('chat_call_links_list', {}, 'GET', { swr: false });
    const items = r && r.success && r.data && Array.isArray(r.data.items) ? r.data.items : null;
    if (items) { _mergeServer(items); return; }
  } catch {}
  const now = Date.now();
  const alive = getMyCallLinks().filter((l) => callLinkState(l, now) === 'active').slice(0, 20);
  await Promise.all(alive.map(async (l) => {
    try {
      const r = await api.chatCallLinkInfo(l.link_id);
      const d = r?.data || r;
      if (r && r.success === false) {
        if (/not found/i.test(String(r.message || ''))) patchMyCallLink(l.link_id, { expired: true });
        return;
      }
      if (d?.revoked) patchMyCallLink(l.link_id, { revoked: true, revoked_at: Date.now() });
      else if (d?.expired) patchMyCallLink(l.link_id, { expired: true });
    } catch {}
  }));
}
