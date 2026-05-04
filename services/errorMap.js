// Generic API error → friendly i18n key mapper. Generalizes the
// `friendlyDriveError` pattern from drive.js into a domain-aware helper
// usable by photos, files, drive, backup, calendar, chat — anywhere we
// alert() a server response.
//
// Usage:
//   const msg = mapApiError(r, t);
//   safeAlert(t('common.error'), msg);
//
// Domain hint: pass `'drive' | 'photos' | 'calendar'` etc. to bias the
// fallback i18n key. Defaults to `common.errorGeneric`.

const NETWORK_PATTERNS = /econnrefused|fetch failed|network|offline|abort/i;
const TIMEOUT_PATTERNS = /etimedout|timed?\s*out|timeout/i;
const NO_SPACE_PATTERNS = /enospc|no space|disk full|quota|storage full/i;
const TOO_LARGE_PATTERNS = /too large|413|payload|request entity/i;
const AUTH_PATTERNS     = /unauthor|401|forbidden|403|expired|invalid token/i;

/**
 * @param {object|string|Error} err — API response object or raw Error
 * @param {function} t — useLanguage().t
 * @param {string} [domain] — 'drive' | 'photos' | 'calendar' | 'common'
 * @returns {string} i18n-resolved string ready to show
 */
export function mapApiError(err, t, domain = 'common') {
  if (!err) return t?.('common.errorGeneric') || 'Não rolou. Tente de novo.';

  // Extract identifiers from various shapes
  const status = (err && (err.status || err.code || err.errno)) || null;
  const messageRaw = (typeof err === 'string')
    ? err
    : (err.message || err.error || err.statusText || '');
  const message = String(messageRaw || '').toLowerCase();

  // Network / offline
  if (status === 'ECONNREFUSED' || NETWORK_PATTERNS.test(message)) {
    return t?.(`${domain}.errorNetwork`) || t?.('common.errorNetwork') || 'Sem conexão. Verifica sua internet.';
  }

  // Timeout
  if (status === 'ETIMEDOUT' || TIMEOUT_PATTERNS.test(message)) {
    return t?.(`${domain}.errorTimeout`) || t?.('common.errorTimeout') || 'Conexão demorou demais. Tenta de novo.';
  }

  // Storage full
  if (status === 'ENOSPC' || NO_SPACE_PATTERNS.test(message)) {
    return t?.(`${domain}.errorStorageFull`) || t?.('common.errorStorageFull') || 'Armazenamento cheio.';
  }

  // Too large
  if (status === 413 || TOO_LARGE_PATTERNS.test(message)) {
    return t?.(`${domain}.errorTooLarge`) || t?.('common.errorTooLarge') || 'Arquivo muito grande.';
  }

  // Auth
  if (status === 401 || status === 403 || AUTH_PATTERNS.test(message)) {
    return t?.(`${domain}.errorAuth`) || t?.('common.errorAuth') || 'Sessão expirada. Faça login de novo.';
  }

  // Short, friendly message? Pass through (server already wrote it for users).
  // Heuristic: < 90 chars, no stack trace markers, no technical jargon.
  const orig = String(messageRaw || '').trim();
  if (orig && orig.length < 90 && !/error:|exception|traceback|undefined|null|TypeError|ReferenceError/i.test(orig)) {
    return orig;
  }

  // Generic fallback
  return t?.(`${domain}.errorGeneric`) || t?.('common.errorGeneric') || 'Não rolou. Tente de novo.';
}
