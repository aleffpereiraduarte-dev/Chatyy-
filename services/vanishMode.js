// services/vanishMode.js — [vanish 2026-10-19] Modo temporário (Instagram Vanish Mode)
// dentro da MESMA conversa. Aqui fica só o estado leve compartilhado:
//   • vanishGateOn()            → kill switch globalThis.__chatyy_vanish (false desliga)
//   • setVanishActive(cid, on)  → a tela da conversa avisa; o VanishThemeScope
//                                 (fora do componente da conversa) escurece o tema.
//   • useVanishActive(cid)      → leitura reativa (só re-renderiza quando muda).
//   • purgeVanishLocal(cid, ids)→ tira as mensagens sumidas dos caches locais.
import { useEffect, useState } from 'react';

export function vanishGateOn() {
  try { return globalThis.__chatyy_vanish !== false; } catch { return true; }
}

const _active = new Map(); // cid → true
const _subs = new Set();

function _k(cid) {
  const s = String(cid == null ? '' : cid);
  return s && s !== 'undefined' && s !== 'null' ? s : '';
}

export function isVanishActive(cid) {
  const k = _k(cid);
  return !!k && _active.get(k) === true;
}

export function setVanishActive(cid, on) {
  const k = _k(cid);
  if (!k) return;
  const next = !!on;
  if ((_active.get(k) === true) === next) return;
  if (next) _active.set(k, true); else _active.delete(k);
  _subs.forEach((fn) => { try { fn(k, next); } catch {} });
}

export function useVanishActive(cid) {
  const k = _k(cid);
  const [on, setOn] = useState(() => isVanishActive(k));
  useEffect(() => {
    setOn(isVanishActive(k));
    const fn = (ck, v) => { if (ck === k) setOn(v); };
    _subs.add(fn);
    return () => { _subs.delete(fn); };
  }, [k]);
  return on;
}

/** Remove ids dos caches locais (JS + SQLite nativo) — best-effort. */
export function purgeVanishLocal(cid, ids) {
  if (!cid || !Array.isArray(ids) || !ids.length) return;
  for (const id of ids) {
    try {
      const { deleteCachedMessage } = require('./chatCache');
      const r = deleteCachedMessage && deleteCachedMessage(cid, id);
      if (r && r.catch) r.catch(() => {});
    } catch {}
    try {
      const SmartCache = require('./smartChatCache');
      SmartCache.updateCachedMessage && SmartCache.updateCachedMessage(cid, id, {
        deleted_at: new Date().toISOString(), content: '', file_url: '', vanish: true,
      });
    } catch {}
  }
}

/** Avisa o servidor que o leitor saiu (somem as já vistas). Devolve ids apagados. */
export async function vanishSeenClose(cid, lastReadId) {
  try {
    const api = require('./api');
    const fn = api.chatVanishSeenClose || (api.default && api.default.chatVanishSeenClose);
    if (typeof fn !== 'function') return [];
    const r = await fn(cid, lastReadId);
    const ids = r && r.success && r.data && Array.isArray(r.data.purged) ? r.data.purged : [];
    return ids;
  } catch { return []; }
}
