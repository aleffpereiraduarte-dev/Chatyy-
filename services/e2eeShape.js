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

// [e2ee5 WP-09/WP-11] campos que a decifragem põe na linha (local, contato, enquete, mídia decifrada,
// LQIP, legenda…): nunca vão para o cache geral — ao recarregar, o envelope é decifrado de novo.
// Mesma lista de services/e2ee/payload.js (DERIVED_KEYS), copiada aqui: este módulo não importa nada.
const V5_DERIVED = ['latitude', 'longitude', 'address', 'live', 'live_until', 'is_unlimited', 'contact', 'poll', 'meetup',
  'file_name', 'file_size', 'mime_type', 'thumb_b64', 'image_width', 'image_height', 'width', 'height',
  'duration', 'waveform', 'batch_id', 'effect', 'is_view_once', 'blurhash',
  '_localUri', '_e5LocalUri', '_posterUri', '_e5Media', '_e5Fwd', '_e5MentionAll', '_e5Hidden', '_e5V', '_e5T', '_e5Rx', '_e5State', '_e5EditOf'];
// citação de pai cifrado: o texto citado só existe decifrado → no cache fica só o id/remetente
function _quoteless(rt) { return rt && typeof rt === 'object' && rt.content ? { ...rt, content: '' } : rt; }

export function toStoredShape(m) {
  if (!m || typeof m !== 'object') return m;
  if (isV5Raw(m._e2eRaw) && (m._e5T || m._e5Ty || m._e5Media || m._localUri || m.poll || m.contact || m.meetup || m.latitude != null)) {
    const out = { ...m, content: m._e2eRaw };
    for (const k of V5_DERIVED) delete out[k];
    if (m._e5Ty) out.type = m._e5Ty;
    delete out._e5Ty;
    if (out.reply_to) out.reply_to = _quoteless(out.reply_to);
    return out;
  }
  if (isV5Raw(m._e2eRaw) && m.content !== m._e2eRaw) {
    const out = { ...m, content: m._e2eRaw };
    if (m._e5Ty) out.type = m._e5Ty;
    delete out._e5Ty; delete out._e5V;
    if (out.reply_to) out.reply_to = _quoteless(out.reply_to);
    return out;
  }
  if (isStoredCipher(m._e2eRaw) && m.content !== m._e2eRaw) return { ...m, content: m._e2eRaw };
  return m;
}

export function mapStored(list) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const out = list.map((m) => { const n = toStoredShape(m); if (n !== m) changed = true; return n; });
  return changed ? out : list;
}
