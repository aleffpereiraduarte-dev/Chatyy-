// Centralized date formatting helpers — use these instead of inline
// toLocaleString/toLocaleDateString chains. Audit 2026-05-05 found 20+
// fragmented helpers (EmailRow, ChannelsTab, ChannelView, MediaGallery,
// SnoozePickerModal, ChatCallsTab) all rolling their own. This module is
// the single source of truth.
//
// All helpers accept the same input shape: ISO string, Date, or epoch ms.
// `t` is the translation function from useLanguage(); falls back to PT-BR.

function _toDate(input) {
  if (!input) return null;
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
  if (typeof input === 'number') {
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof input === 'string') {
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const _DAY_MS = 86400000;

// "agora", "5min", "2h", "ontem", "ter 14:30", "12 mar", "12/03/2024"
// WhatsApp-style relative format. The most-used helper.
export function formatRelative(input, t) {
  const d = _toDate(input);
  if (!d) return '';
  const now = Date.now();
  const diffSec = Math.floor((now - d.getTime()) / 1000);
  const tt = t || ((k, fb) => fb);
  if (diffSec < 30) return tt('time.now', 'agora');
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}min`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  // Yesterday
  const dStart = new Date(d); dStart.setHours(0, 0, 0, 0);
  const nowStart = new Date(); nowStart.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((nowStart - dStart) / _DAY_MS);
  if (dayDiff === 1) return tt('time.yesterday', 'ontem');
  if (dayDiff < 7) {
    // "seg", "ter", etc + HH:mm
    return d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  if (d.getFullYear() === new Date().getFullYear()) {
    return d.toLocaleString(undefined, { day: '2-digit', month: 'short' });
  }
  return d.toLocaleDateString();
}

// "13:42" — only the time part, locale-aware.
export function formatTime(input) {
  const d = _toDate(input);
  if (!d) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// "Hoje 13:42" / "Ontem 09:15" / "Ter 14:30" / "12 mar 13:42"
// For chat list rows / inbox where you want both date and time visible.
export function formatDateTime(input, t) {
  const d = _toDate(input);
  if (!d) return '';
  const tt = t || ((k, fb) => fb);
  const time = formatTime(d);
  const dStart = new Date(d); dStart.setHours(0, 0, 0, 0);
  const nowStart = new Date(); nowStart.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((nowStart - dStart) / _DAY_MS);
  if (dayDiff === 0) return `${tt('time.today', 'Hoje')} ${time}`;
  if (dayDiff === 1) return `${tt('time.yesterday', 'Ontem')} ${time}`;
  if (dayDiff < 7) {
    const wd = d.toLocaleString(undefined, { weekday: 'short' });
    return `${wd} ${time}`;
  }
  const day = d.toLocaleString(undefined, { day: '2-digit', month: 'short' });
  return `${day} ${time}`;
}

// Long form: "12 de março, 2024 às 13:42" — for detail screens
// (event-detail, meeting-detail, message info).
export function formatLong(input) {
  const d = _toDate(input);
  if (!d) return '';
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// "5min", "1h 23min", "2h" — duration in seconds → readable string
// (call duration, voice clip length, video length).
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}:${String(r).padStart(2, '0')}` : `${m}min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}min` : `${h}h`;
}
