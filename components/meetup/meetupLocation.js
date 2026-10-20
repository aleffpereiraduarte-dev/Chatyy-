// [encontro 2026-10-19] Formato do campo `location` do encontro (servidor guarda até 200 chars):
//   "Nome do lugar, Endereço|lat,lng"   (coords opcionais; cartões antigos = só texto)
// O servidor corta em 200 → o texto é encurtado ANTES p/ as coordenadas nunca se perderem.

const COORD_RE = /\|\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

export function parseMeetupLocation(raw) {
  const s = String(raw || '').trim();
  if (!s) return { text: '', lat: null, lng: null };
  const m = s.match(COORD_RE);
  if (!m) return { text: s, lat: null, lng: null };
  const lat = Number(m[1]); const lng = Number(m[2]);
  const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  return { text: s.slice(0, m.index).trim(), lat: ok ? lat : null, lng: ok ? lng : null };
}

export function formatMeetupLocation({ title, address, lat, lng }) {
  const parts = [];
  const t = String(title || '').trim();
  const a = String(address || '').trim();
  if (t) parts.push(t);
  if (a && a !== t && !a.startsWith(t + ',')) parts.push(a);
  else if (a && !t) parts.push(a);
  let text = parts.join(', ').replace(/\|/g, ' ');
  const la = Number(lat); const lo = Number(lng);
  const hasC = Number.isFinite(la) && Number.isFinite(lo);
  const suffix = hasC ? `|${la.toFixed(6)},${lo.toFixed(6)}` : '';
  const max = 200 - suffix.length;
  if (text.length > max) text = text.slice(0, max - 1).replace(/[\s,]+$/, '') + '…';
  return text + suffix;
}

/** Data local com fuso ("2026-10-25T15:00:00-03:00") — legível por new Date() em todo cliente. */
export function meetupDateIso(d) {
  const p = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${sign}${p(off / 60)}:${p(off % 60)}`;
}
