// [2026-10-14 mailto-unmatched] Extrai o endereço de um caminho/URL que é só
// um e-mail ("onemundomail://x@y.com", "/x@y.com", "x@y.com"). Usado por
// app/+native-intent.js e app/+not-found.js p/ abrir o compose em vez de 404.
const _EMAIL_IN_PATH = /^(?:[a-z][a-z0-9+.-]*:(?:\/\/)?)?\/*([^\/?#\s@]+@[^\/?#\s@]+\.[a-z]{2,})(?:[?#].*)?$/i;
export function emailFromSystemPath(path) {
  if (typeof path !== 'string' || path.indexOf('@') < 0) return null;
  let p = path;
  try { p = decodeURIComponent(path); } catch {}
  const m = p.match(_EMAIL_IN_PATH);
  return m ? m[1] : null;
}
