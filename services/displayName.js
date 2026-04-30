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
