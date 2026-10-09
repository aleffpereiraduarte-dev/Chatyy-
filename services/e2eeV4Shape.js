/**
 * [2026-10-09 e2ee v4] Forma de PERSISTÊNCIA de uma mensagem cifrada v4:
 * os caches gerais do chat (SQLite/MMKV/localStorage/IndexedDB) guardam o
 * ENVELOPE, nunca o texto decifrado nem o placeholder "..." — o texto só
 * vive no cache cifrado do e2eeV4 (services/e2eeV4.js). Ao recarregar, o
 * envelope volta pelo normalizador e é decifrado de novo (cache local).
 * Módulo puro, sem dependências (seguro em qualquer caminho de cache).
 */
export function isV4Raw(s) {
  return typeof s === 'string' && s.startsWith('{"e2e":4');
}

export function toStoredShape(m) {
  if (!m || typeof m !== 'object') return m;
  if (isV4Raw(m._e2eRaw) && m.content !== m._e2eRaw) return { ...m, content: m._e2eRaw };
  return m;
}

export function mapStored(list) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const out = list.map((m) => { const n = toStoredShape(m); if (n !== m) changed = true; return n; });
  return changed ? out : list;
}
