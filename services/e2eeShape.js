/**
 * [e2ee5 WP-08c 2026-10-21] Forma de PERSISTÊNCIA de mensagem cifrada (v4 + v5).
 * Os caches gerais do chat (SQLite/MMKV/localStorage/IndexedDB) guardam o ENVELOPE,
 * nunca o texto decifrado nem o placeholder: o texto só vive no cache local próprio
 * (v4: services/e2eeV4.js; v5: services/e2ee/e2ee5.js). Ao recarregar, o envelope
 * volta pelo normalizador e é decifrado de novo (cache local).
 * Módulo puro, sem dependências (seguro em qualquer caminho de cache).
 */
export function isV4Raw(s) {
  return typeof s === 'string' && s.startsWith('{"e2e":4');
}

/** `{"e2e":N…}` com N ≥ 5 (v5 e versões futuras: placeholder "Atualize"). */
export function isV5Raw(s) {
  if (typeof s !== 'string' || !s.startsWith('{"e2e":')) return false;
  const c = s.charCodeAt(7);
  if (c >= 53 && c <= 57) return true;           // 5..9
  return c >= 49 && c <= 57 && s.charCodeAt(8) >= 48 && s.charCodeAt(8) <= 57; // 10+
}

export function isStoredCipher(s) { return isV4Raw(s) || isV5Raw(s); }

export function toStoredShape(m) {
  if (!m || typeof m !== 'object') return m;
  if (isStoredCipher(m._e2eRaw) && m.content !== m._e2eRaw) return { ...m, content: m._e2eRaw };
  return m;
}

export function mapStored(list) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const out = list.map((m) => { const n = toStoredShape(m); if (n !== m) changed = true; return n; });
  return changed ? out : list;
}
