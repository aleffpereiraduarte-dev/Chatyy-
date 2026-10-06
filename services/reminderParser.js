// ============================================================
// REMINDER PARSER — natural-language date/time extraction for chat
// "smart action" reminders (pt-BR / en / es). Pure JS, no RN imports so it
// can be unit-tested in plain node.
//
// Google-Messages / WhatsApp style defaults:
//   "de manhã" / "cedo" / "quando acordar" → 08:00
//   "almoço"                                → 12:00
//   "à tarde"                               → 14:00
//   "à noite" / "tonight"                   → 20:00
//   no time at all                          → 09:00
//
// [2026-10-06] Replaces the inline parseSmartDate() in chat-conversation.js
// for the reminder chip. The old parser handled "amanhã" but defaulted to
// 10:00 and ignored period words ("quando acordar"); worse, the tap handler
// pushed /event-detail?create=1 which the screen never read → spinner forever,
// nothing created ("Criar lembrete não funciona", founder).
// ============================================================

const DEFAULTS = { morning: 8, lunch: 12, afternoon: 14, evening: 20, endOfDay: 18, none: 9 };

// Strip accents + lowercase so one regex set covers "amanhã"/"amanha", "às"/"as".
export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words that signal "please remind me". Kept broad (pt/en/es) — the chip
// only appears when a date/time ALSO parses, so a bare "me avisa" is ignored.
const INTENT_RX = new RegExp([
  // pt
  'me lembr[ae]r?', 'lembr[ae][- ]?me', 'lembrar(?: de| que)?', 'lembrete',
  'nao (?:me )?(?:deixa|deixe) esquecer', 'nao (?:me )?esquec[ae]r?', 'me avis[ae]', 'avis[ae][- ]?me',
  // en
  'remind me', 'reminder', "don'?t (?:let me )?forget", 'wake me',
  // es
  'recuerda(?:me)?', 'recordar(?:me)?', 'avisa?me', 'no (?:me )?(?:dejes )?olvid(?:ar|es)',
].join('|').replace(/ /g, '\\s+'), 'i');

// Hoisted: runs once per rendered message bubble.
const INTENT_BOUNDED_RX = new RegExp('(?:^|[^a-z])(?:' + INTENT_RX.source + ')(?![a-z])', 'i');
export function hasReminderIntent(text) {
  const n = normalizeText(text);
  if (!n) return false;
  return INTENT_BOUNDED_RX.test(n);
}

const WEEKDAYS = {
  // pt (3-letter "ter"/"qua" dropped: "ter" = verb "to have", too noisy)
  'domingo': 0, 'dom': 0, 'segunda': 1, 'seg': 1, 'terca': 2, 'quarta': 3, 'quinta': 4, 'qui': 4,
  'sexta': 5, 'sex': 5, 'sabado': 6, 'sab': 6,
  // en
  'sunday': 0, 'sun': 0, 'monday': 1, 'mon': 1, 'tuesday': 2, 'tue': 2, 'tues': 2, 'wednesday': 3, 'wed': 3,
  'thursday': 4, 'thu': 4, 'thurs': 4, 'friday': 5, 'fri': 5, 'saturday': 6, 'sat': 6,
  // es
  'lunes': 1, 'martes': 2, 'miercoles': 3, 'jueves': 4, 'viernes': 5,
};

const NUM_WORDS = {
  'um': 1, 'uma': 1, 'one': 1, 'a': 1, 'an': 1, 'un': 1, 'una': 1,
  'dois': 2, 'duas': 2, 'two': 2, 'dos': 2,
  'tres': 3, 'three': 3,
  'quatro': 4, 'four': 4, 'cuatro': 4,
  'cinco': 5, 'five': 5,
  'seis': 6, 'six': 6,
  'dez': 10, 'ten': 10, 'diez': 10,
  'quinze': 15, 'fifteen': 15, 'quince': 15,
  'vinte': 20, 'twenty': 20, 'veinte': 20,
  'trinta': 30, 'thirty': 30, 'treinta': 30,
  'meia': 0.5, 'half': 0.5, 'media': 0.5,
};

function toNum(tok) {
  if (/^\d+$/.test(tok)) return parseInt(tok, 10);
  return NUM_WORDS[tok] != null ? NUM_WORDS[tok] : null;
}

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

/**
 * parseReminderDate(text, now?) → null | {
 *   date: Date, hasTime: boolean, hasDay: boolean, past: boolean,
 *   source: 'relative'|'absolute'
 * }
 * Returns null when the text carries NO date/time hint at all.
 */
export function parseReminderDate(text, now = new Date()) {
  let s = normalizeText(text);
  if (!s) return null;
  const nowMs = now.getTime();

  // ---- 1. relative durations: "em 2h", "daqui a 30 min", "in 3 hours", "en 2 dias", "meia hora"
  const relRx = /(?:^|\s)(?:em|daqui(?: a)?|dentro de|in|en|after|apos|depois de)\s+(\d+|[a-z]+)\s*(min(?:uto)?s?|m|h|hrs?|hora?s?|hours?|dias?|days?|semanas?|weeks?)(?![a-z])/;
  let m = s.match(relRx);
  if (!m) {
    // "em meia hora" / "in half an hour"
    const mh = s.match(/(?:^|\s)(?:em|daqui(?: a)?|in|en)\s+(meia|half(?: an?)?|media)\s+(hora|hour)/);
    if (mh) m = [mh[0], mh[1].split(' ')[0], mh[2]];
  }
  if (m) {
    const qty = toNum(m[1]);
    if (qty != null && qty > 0) {
      const unit = m[2];
      let ms = 0;
      if (/^(min|m)/.test(unit)) ms = qty * 60000;
      else if (/^(h|hora|hour|hrs?)/.test(unit)) ms = qty * 3600000;
      else if (/^(dia|day)/.test(unit)) ms = qty * 86400000;
      else if (/^(semana|week)/.test(unit)) ms = qty * 7 * 86400000;
      if (ms > 0) {
        const d = new Date(nowMs + ms);
        d.setSeconds(0, 0);
        return { date: d, hasTime: true, hasDay: true, past: false, source: 'relative' };
      }
    }
  }

  // ---- 2. explicit calendar date DD/MM[/YYYY] — consume it so the digits
  //         don't get mistaken for a time below.
  let dayDate = null;      // Date at 00:00 of the resolved day (or null)
  let hasDay = false;
  m = s.match(/(?:^|\D)(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?!\d)/);
  if (m) {
    const dd = parseInt(m[1], 10), mm = parseInt(m[2], 10) - 1;
    let yy = m[3] ? parseInt(m[3], 10) : now.getFullYear();
    if (m[3] && yy < 100) yy += 2000;
    if (dd >= 1 && dd <= 31 && mm >= 0 && mm <= 11) {
      let d = new Date(yy, mm, dd, 0, 0, 0, 0);
      if (!m[3] && d.getTime() < startOfDay(now).getTime()) d.setFullYear(yy + 1);
      dayDate = d; hasDay = true;
      s = s.replace(m[0], ' ');
    }
  }

  // ---- 3. day words
  const isSpanishMorning = /(?:por|en|de|a) la manana/.test(s); // "mañana" = morning here
  if (!dayDate) {
    if (/depois de amanha|day after tomorrow|pasado manana/.test(s)) { dayDate = startOfDay(addDays(now, 2)); hasDay = true; }
    else if (/(?:^|[^a-z])(?:amanha|tomorrow|tmrw)(?![a-z])/.test(s) || (/(?:^|[^a-z])manana(?![a-z])/.test(s) && !isSpanishMorning)) {
      dayDate = startOfDay(addDays(now, 1)); hasDay = true;
    } else if (/(?:^|[^a-z])(?:hoje|today|hoy|tonight|logo mais|mais tarde|later today)(?![a-z])/.test(s)) {
      dayDate = startOfDay(now); hasDay = true;
    } else {
      // "dia 15" / "on the 15th" / "el 15"
      const dm = s.match(/(?:^|\s)(?:dia|on the|el)\s+(\d{1,2})(?:st|nd|rd|th)?(?![\d:h\/])/);
      if (dm) {
        const dd = parseInt(dm[1], 10);
        if (dd >= 1 && dd <= 31) {
          let d = new Date(now.getFullYear(), now.getMonth(), dd);
          if (d.getTime() < startOfDay(now).getTime()) d = new Date(now.getFullYear(), now.getMonth() + 1, dd);
          dayDate = d; hasDay = true; s = s.replace(dm[0], ' ');
        }
      }
    }
  }
  // weekday ("sexta", "sexta-feira", "next friday", "el viernes")
  let weekdayHit = null;
  if (!dayDate) {
    for (const key of Object.keys(WEEKDAYS)) {
      const rx = new RegExp('(?:^|[^a-z])' + key + '(?:-?feira)?(?![a-z])');
      if (rx.test(s)) { weekdayHit = WEEKDAYS[key]; break; }
    }
    if (weekdayHit != null) {
      let diff = (weekdayHit - now.getDay() + 7) % 7;
      const nextWord = /(?:proxim[ao]|next|que vem|siguiente)/.test(s);
      if (diff === 0 && nextWord) diff = 7;
      dayDate = startOfDay(addDays(now, diff)); hasDay = true;
    }
  }

  // ---- 4. time of day
  let hour = null, minute = 0, hasTime = false;
  if (/meio[- ]?dia|(?:^|[^a-z])noon(?![a-z])|mediodia/.test(s)) { hour = 12; hasTime = true; }
  else if (/meia[- ]?noite|midnight|medianoche/.test(s)) { hour = 0; hasTime = true; }
  else {
    // "às 8", "as 8h", "8:30", "8h30", "at 8", "a las 8", "8 pm", "8 da noite"
    const timeRx = /(?:^|[^\d\/])(?:(?:as|a las|at|a|um|uma|the)\s+)?(\d{1,2})(?:(?::|h|\.)(\d{2})?|\s*(?=(?:am|pm|a\.m|p\.m|da manha|da tarde|da noite|de la manana|de la tarde|de la noche|in the morning|in the afternoon|in the evening|at night|o'?clock|horas?)(?![a-z])))\s*(am|pm|a\.m\.?|p\.m\.?|da manha|da tarde|da noite|de la manana|de la tarde|de la noche|in the morning|in the afternoon|in the evening|at night|o'?clock|horas?)?(?![a-z\d\/])/;
    let tm = s.match(timeRx);
    if (!tm) {
      // bare "às 8" / "at 8" / "a las 8" with no suffix
      tm = s.match(/(?:^|[^a-z])(?:as|a las|at)\s+(\d{1,2})(?![\d:h\/])()()/);
    }
    if (tm) {
      let h = parseInt(tm[1], 10);
      const mn = tm[2] ? parseInt(tm[2], 10) : 0;
      const suf = (tm[3] || '').replace(/\./g, '');
      if (h >= 0 && h <= 24 && mn >= 0 && mn < 60) {
        if (/^pm|tarde|noite|noche|afternoon|evening|night/.test(suf) && h < 12) h += 12;
        if (/^am|manha|manana|morning/.test(suf) && h === 12) h = 0;
        // "8 da noite" → 20; "1 da tarde" → 13 handled above. Bare hour with
        // evening period word elsewhere in the text ("hoje à noite às 8") → 20.
        if (!suf && h < 12 && h >= 5 && /(?:^|[^a-z])(?:noite|tonight|evening|night|noche)(?![a-z])/.test(s)) h += 12;
        if (!suf && h < 12 && h >= 1 && h <= 6 && /(?:^|[^a-z])(?:tarde|afternoon)(?![a-z])/.test(s)) h += 12;
        if (h === 24) h = 0;
        hour = h; minute = mn; hasTime = true;
      }
    }
  }

  // ---- 5. period words (only when no explicit clock time)
  let period = null;
  if (!hasTime) {
    if (/acordar|wake|despert|(?:^|[^a-z])(?:cedo|cedinho|early|temprano)(?![a-z])|(?:de|pela|na) manha|morning|por la manana|en la manana|a la manana|de la manana|(?:^|[^a-z])manha(?![a-z])/.test(s)) period = 'morning';
    else if (/almoco|(?:^|[^a-z])lunch(?![a-z])|almuerzo/.test(s)) period = 'lunch';
    else if (/(?:^|[^a-z])(?:tarde|afternoon)(?![a-z])/.test(s)) period = 'afternoon';
    else if (/(?:^|[^a-z])(?:noite|tonight|evening|night|noche)(?![a-z])/.test(s)) period = 'evening';
    else if (/fim do dia|final do dia|end of (?:the )?day|fin del dia/.test(s)) period = 'endOfDay';
    if (period) hour = DEFAULTS[period];
  }

  // Nothing date-like at all → no chip.
  if (!hasDay && !hasTime && !period) return null;

  // ---- 6. resolve
  const wakeNoDay = !hasDay && /acordar|wake|despert/.test(s);
  if (hour == null) hour = DEFAULTS.none;
  let d;
  if (dayDate) {
    d = new Date(dayDate); d.setHours(hour, minute, 0, 0);
    // "sexta às 8" said ON friday after 08:00 → next friday
    if (weekdayHit != null && d.getTime() <= nowMs) d = addDays(d, 7);
  } else {
    d = new Date(now); d.setHours(hour, minute, 0, 0);
    // "quando acordar" with no day → tomorrow morning (unless it's the small hours)
    if (wakeNoDay && now.getHours() >= 6) d = addDays(d, 1);
    // time already passed today → tomorrow
    else if (d.getTime() <= nowMs) d = addDays(d, 1);
  }
  return { date: d, hasTime: hasTime || !!period, hasDay, past: d.getTime() <= nowMs, source: 'absolute' };
}

/**
 * detectReminder(text, now?) → null | { date, hasTime, past }
 * Intent word + parseable date. This is what the chat chip uses.
 */
export function detectReminder(text, now = new Date()) {
  if (typeof text !== 'string' || text.length < 4 || text.length > 2000) return null;
  if (!hasReminderIntent(text)) return null;
  const r = parseReminderDate(text, now);
  if (!r) return null;
  return r;
}

export const REMINDER_DEFAULTS = DEFAULTS;
