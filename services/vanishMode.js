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

// [2026-10-22 vanish-lembra] Último estado CONHECIDO por conversa no aparelho (MMKV): voltar à
// conversa já pinta o tema escuro no 1º quadro, sem esperar a resposta do servidor (antes:
// começava claro e só escurecia depois do chat_messages). O servidor continua mandando
// (WS conversation_vanish / chat_messages.vanish_mode) e corrige se mudou.
function _mm() { try { return require('./mmkv'); } catch { return null; } }
export function knownVanish(cid) {
  const k = _k(cid);
  if (!k || !vanishGateOn()) return false;
  try { const m = _mm(); return !!(m && m.getString && m.getString('vanish_on_' + k) === '1'); } catch { return false; }
}
export function rememberVanish(cid, on) {
  const k = _k(cid);
  if (!k) return;
  try {
    const m = _mm();
    if (!m) return;
    if (on) { if (m.getString('vanish_on_' + k) !== '1') m.setString('vanish_on_' + k, '1'); }
    else if (m.getString('vanish_on_' + k)) { if (m.remove) m.remove('vanish_on_' + k); else m.setString('vanish_on_' + k, ''); }
  } catch {}
}

export function useVanishActive(cid) {
  const k = _k(cid);
  const [on, setOn] = useState(() => isVanishActive(k) || knownVanish(k));
  useEffect(() => {
    setOn(isVanishActive(k) || knownVanish(k));
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
