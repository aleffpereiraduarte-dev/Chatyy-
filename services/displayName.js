/**
 * Beautify a Chatyy email/handle into a human display name when the backend
 * didn't fill `name` or `display_name`.
 *   "anacarla.pereiraramos@chatyy.com.br" → "Anacarla Pereiraramos"
 *   "joao.marcelo"                         → "Joao Marcelo"
 *   "+5511..."                             → "+5511..." (phone passes through)
 */
export function prettifyHandle(s) {
  if (!s || typeof s !== 'string') return s || '';
  if (/^\+?\d[\d\s\-()]{4,}$/.test(s.trim())) return s;
  let local = s.replace(/@(chatyy\.com\.br|chatyy\.com|onemundo\.com\.br)$/i, '');
  if (local.includes('@')) local = local.split('@')[0];
  local = local.replace(/[._-]+/g, ' ').trim();
  if (!local) return s;
  return local.replace(/\b(\w)/g, c => c.toUpperCase());
}

export function displayNameFor(user) {
  if (!user) return '';
  if (user.display_name && user.display_name.trim()) return user.display_name;
  if (user.name && user.name.trim() && !user.name.includes('@')) return user.name;
  return prettifyHandle(user.email || user.handle || user.name || '');
}

/**
 * Clean a LiveKit / live-broadcast participant into a human display name.
 * LK identity for Chatyy is `email#hash` (e.g. `suporte@boraum.com.br#726c60fd`).
 * We must NEVER let that identity hit user-visible UI — both the email and the
 * hash leak privacy. Order of preference:
 *   1. participant.name if it's clearly already a display name (no `@`, no `#`)
 *   2. participant.metadata JSON → { displayName | name }
 *   3. participant.identity → strip `#<hash>` → email local-part → prettify
 *
 *   "suporte@boraum.com.br#726c60fd" → "Suporte"
 *   "ana.julia@chatyy.com.br#abc123"  → "Ana Julia"
 *   "+5511999999999"                  → "+5511999999999"
 */
export function cleanParticipantName(participant) {
  if (!participant) return 'Convidado';
  const rawName = typeof participant.name === 'string' ? participant.name.trim() : '';
  if (rawName && !rawName.includes('@') && !rawName.includes('#')) return rawName;
  // metadata may be a JSON string LiveKit ships verbatim
  const meta = participant.metadata;
  if (meta) {
    try {
      const m = typeof meta === 'string' ? JSON.parse(meta) : meta;
      const dn = (m && (m.displayName || m.name)) ? String(m.displayName || m.name).trim() : '';
      if (dn && !dn.includes('@') && !dn.includes('#')) return dn;
    } catch {}
  }
  const identity = typeof participant.identity === 'string' ? participant.identity : '';
  if (identity) {
    const noHash = identity.split('#')[0] || identity;
    const localPart = (noHash.split('@')[0] || noHash).trim();
    const pretty = prettifyHandle(localPart);
    if (pretty) return pretty;
  }
  return 'Convidado';
}
