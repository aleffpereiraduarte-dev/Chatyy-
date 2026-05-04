// Shared date/time formatters — extracted to consolidate ~15 inline variants
// across drive.js, files.js, calendar.js, event-detail.js, meeting-recap.js,
// plans.js, etc. Each screen used to reimplement relative time and locale-
// aware formatting; now everyone uses the same logic.
//
// All formatters take a Date | number (epoch ms) | string — flexible input.
// All take an optional `t()` from useLanguage() for i18n; fall back to PT-BR
// strings if `t` not supplied.

function _toDate(d) {
  if (d instanceof Date) return d;
  if (typeof d === 'number') return new Date(d);
  if (typeof d === 'string') {
    const ts = Date.parse(d);
    if (!Number.isNaN(ts)) return new Date(ts);
  }
  return null;
}

/**
 * "agora", "5 min", "2 h", "ontem", "3 dias", "Mar 15", "Mar 15, 2024"
 * (or English/Spanish equivalents via t).
 */
export function formatRelativeTime(input, t) {
  const d = _toDate(input);
  if (!d) return '';
  const now = Date.now();
  const diffMs = now - d.getTime();
  const sec = Math.round(diffMs / 1000);

  if (sec < 60) return t?.('time.now') || 'agora';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} ${t?.('time.min') || 'min'}`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} ${t?.('time.h') || 'h'}`;
  const day = Math.round(hr / 24);
  if (day === 1) return t?.('time.yesterday') || 'ontem';
  if (day < 7) return `${day} ${t?.('time.days') || 'dias'}`;
  // > 7 days → short locale month/day
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "15/03/2024" — locale-aware short date. */
export function formatShortDate(input) {
  const d = _toDate(input);
  if (!d) return '';
  return d.toLocaleDateString();
}

/** "15:30" — locale-aware time. */
export function formatTime(input) {
  const d = _toDate(input);
  if (!d) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "15 de março, 2024" — long, locale-aware. */
export function formatLongDate(input) {
  const d = _toDate(input);
  if (!d) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Range: "15:30–17:00" or "15 mar, 15:30–17:00" if multi-day. */
export function formatTimeRange(start, end, allDay = false, t) {
  const s = _toDate(start);
  const e = _toDate(end);
  if (!s) return '';
  if (allDay) return t?.('event.allDay') || 'Dia inteiro';
  if (!e) return formatTime(s);
  const sameDay = s.toDateString() === e.toDateString();
  return sameDay
    ? `${formatTime(s)}–${formatTime(e)}`
    : `${formatShortDate(s)} ${formatTime(s)} – ${formatShortDate(e)} ${formatTime(e)}`;
}

/** "Hoje", "Amanhã", "Ontem", or short date. Used in calendar headers. */
export function formatDayLabel(input, t) {
  const d = _toDate(input);
  if (!d) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return t?.('time.today') || 'Hoje';
  if (diff === 1) return t?.('time.tomorrow') || 'Amanhã';
  if (diff === -1) return t?.('time.yesterday') || 'Ontem';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
}
