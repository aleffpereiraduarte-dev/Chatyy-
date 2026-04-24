/**
 * Normalize a date string that came from PostgreSQL so Safari/iOS can parse
 * it. PG serializes timestamptz as "2026-04-20 18:20:47.77483+00" — space
 * separator + bare "+00" zone. Safari returns Invalid Date → NaN, which
 * cascades into NaN in toLocaleString, toISOString, and subtraction math.
 *
 * Returns an ISO-8601 string Safari accepts, or '' for empty input.
 */
export function normalizeIso(dateStr) {
  if (!dateStr) return '';
  let s = String(dateStr).trim();
  s = s.replace(' ', 'T');
  if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  const bareTz = s.match(/([+-]\d{2})$/);
  if (bareTz) return s.slice(0, -bareTz[0].length) + bareTz[0] + ':00';
  return s + 'Z';
}

/** new Date() but safe on PG timestamps. Returns null when unparseable. */
export function safeDate(ts) {
  if (!ts) return null;
  const d = new Date(normalizeIso(ts));
  return isNaN(d.getTime()) ? null : d;
}

/** Epoch ms from a PG timestamp, or 0 when unparseable — useful for sort keys. */
export function safeDateMs(ts) {
  const d = safeDate(ts);
  return d ? d.getTime() : 0;
}
