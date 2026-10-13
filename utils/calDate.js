// [2026-10-13 calendario] Datas do CALENDÁRIO são "relógio de parede" do dono
// (cal_events.start_at = 'Y-m-d H:i:s' SEM fuso, gravado a partir da hora local
// do aparelho). api.parseServerDate() trata string sem fuso como UTC (correto
// p/ chat/reuniões), o que jogava os blocos da Semana 3h mais cedo no Brasil e
// marcava "agora" no evento errado. Aqui: string nua → hora LOCAL; com Z/offset
// → respeita o offset. Puro JS (testável em node).

const BARE_RX = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;

export function parseCalDate(value) {
  if (value == null || value === '') return new Date(NaN);
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const s = String(value).trim();
  const m = s.match(BARE_RX);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0, 0);
  }
  let iso = s.replace(/(\.\d{3})\d+/, '$1');
  iso = iso.replace(/([+-]\d{2})(\d{2})?$/, (mm, h, mi) => (/T\d{2}:\d{2}/.test(iso) ? `${h}:${mi || '00'}` : mm));
  return new Date(iso);
}

const p2 = (n) => (n < 10 ? '0' + n : '' + n);

// Date → 'YYYY-MM-DDTHH:MM:00' (hora local, formato que cal_create/update aceitam)
export function toCalString(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:00`;
}

export function dayKey(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

export function startOfDay(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x;
}

export function addDays(d, n) {
  const x = new Date(d); x.setDate(x.getDate() + n); return x;
}

export function sameDay(a, b) {
  return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function hhmm(d) {
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// Eventos (não dia-inteiro) que tocam o dia `day`, ordenados.
export function eventsOnDay(events, day) {
  const ds = startOfDay(day).getTime();
  const de = ds + 86400000 - 1;
  return (events || []).filter((e) => {
    const s = parseCalDate(e.start_at).getTime();
    const en = parseCalDate(e.end_at || e.start_at).getTime();
    return Number.isFinite(s) && s <= de && (Number.isFinite(en) ? en : s) >= ds;
  }).sort((a, b) => {
    if (a.all_day && !b.all_day) return -1;
    if (!a.all_day && b.all_day) return 1;
    return parseCalDate(a.start_at) - parseCalDate(b.start_at);
  });
}

/**
 * Janelas livres num dia (default 08:00–20:00), mín. `minMinutes`.
 * Ignora dia-inteiro. Se o dia é hoje, começa em "agora" arredondado p/ 15min.
 * → [{ start: Date, end: Date, minutes }]
 */
export function freeSlots(events, day, { from = 8, to = 20, minMinutes = 30, now = new Date() } = {}) {
  const base = startOfDay(day);
  let cursor = new Date(base); cursor.setHours(from, 0, 0, 0);
  const limit = new Date(base); limit.setHours(to, 0, 0, 0);
  if (sameDay(base, now) && now > cursor) {
    cursor = new Date(now);
    const m = cursor.getMinutes();
    cursor.setMinutes(m + ((15 - (m % 15)) % 15), 0, 0);
  }
  if (cursor >= limit) return [];
  const busy = eventsOnDay(events, day)
    .filter((e) => !e.all_day)
    .map((e) => [parseCalDate(e.start_at).getTime(), parseCalDate(e.end_at || e.start_at).getTime()])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e))
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  let c = cursor.getTime();
  const L = limit.getTime();
  for (const [s, e] of busy) {
    if (e <= c) continue;
    if (s >= L) break;
    if (s - c >= minMinutes * 60000) out.push({ start: new Date(c), end: new Date(Math.min(s, L)), minutes: Math.round((Math.min(s, L) - c) / 60000) });
    c = Math.max(c, e);
    if (c >= L) break;
  }
  if (L - c >= minMinutes * 60000) out.push({ start: new Date(c), end: new Date(L), minutes: Math.round((L - c) / 60000) });
  return out;
}
