// components/calls/myCallLinks.js — [2026-10-16 wave12-D] "Meus links de chamada".
//
// O servidor NÃO tem ação de listar os links do criador (só create / info /
// join / revoke em chat.php). Até existir `chat_call_links_list`, guardamos no
// aparelho os links criados aqui — no cache POR CONTA (services/cache prefixa
// o e-mail logado → nunca vaza entre contas) — e conferimos o estado real
// (revogado/expirado) com `chat_call_link_info` ao abrir a folha.
//
// Registro: { link_id, url, is_video, created_at (ms), expires_at (ms), revoked }
// Links mortos há mais de 30 dias saem sozinhos; teto de 50 entradas.

import { useEffect, useState } from 'react';

const KEY = 'my_call_links_v1';
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

export function removeMyCallLink(linkId) {
  _write(_read().filter((l) => l && l.link_id !== linkId));
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
