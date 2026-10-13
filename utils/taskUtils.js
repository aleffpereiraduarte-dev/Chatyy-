// [2026-10-13 tarefas] Helpers puros das Tarefas (filtros inteligentes, rótulo
// de prazo, entrada rápida em linguagem natural). Sem RN → testável em node.
import { parseReminderDate } from '../services/reminderParser';
import { parseCalDate, startOfDay, addDays, sameDay, hhmm } from './calDate';

// Remove expressões de data/hora (pt/en/es) p/ sobrar o título. Fronteira de
// palavra manual: \b do JS não entende acentos ("amanhã", "às").
const _B = '(^|[^0-9A-Za-z\\u00C0-\\u024F])';
const _E = '(?=$|[^0-9A-Za-z\\u00C0-\\u024F])';
const _DATE_WORDS = [
  '(?:depois de amanh[ãa]|amanh[ãa]|hoje|tomorrow|today|hoy|pasado ma[ñn]ana|ma[ñn]ana)',
  '(?:(?:na |no |nesta |neste |pr[óo]xim[ao] |next |el |este )?(?:domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado)(?:-feira)?(?: que vem)?)',
  '(?:(?:next |on )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))',
  '(?:(?:lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo))',
  '(?:(?:[àa]s?|at|a las|by)\\s+)\\d{1,2}(?::\\d{2}|h\\d{0,2})?(?:\\s*(?:da manh[ãa]|da tarde|da noite|am|pm|horas?))?',
  '\\d{1,2}(?::\\d{2}|h\\d{0,2})(?:\\s*(?:da manh[ãa]|da tarde|da noite|am|pm))?',
  '\\d{1,2}\\s*(?:am|pm|da manh[ãa]|da tarde|da noite|horas)',
  '(?:(?:dia|em|on|el)\\s+)?\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?',
  '(?:dia\\s+\\d{1,2})',
  '(?:de manh[ãa]|pela manh[ãa]|[àa] tarde|[àa] noite|de noite|meio[- ]dia|in the morning|tonight)',
  '(?:(?:em|daqui a|daqui|in|en)\\s+\\d+\\s*(?:min(?:utos?)?|h(?:oras?)?|dias?|days?|hours?|semanas?|weeks?))',
].map((w) => new RegExp(_B + w + _E, 'gi'));
export function stripDateWords(text) {
  let out = ' ' + String(text || '') + ' ';
  for (let i = 0; i < 2; i++) _DATE_WORDS.forEach((rx) => { out = out.replace(rx, '$1 '); });
  return out.replace(/\s{2,}/g, ' ').replace(/^[\s,.;-]+|[\s,.;-]+$/g, '').trim();
}

export const PRIORITY_MARK = ['', '!', '!!', '!!!'];

export function dueDate(task) {
  if (!task?.due_at) return null;
  // Dia inteiro: o servidor guarda a DATA (meio-dia UTC) → usa só AAAA-MM-DD
  // no fuso local (senão +12/+13h viraria o dia).
  if (task.due_all_day) {
    const m = String(task.due_at).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
  }
  const d = parseCalDate(task.due_at);
  return Number.isFinite(d.getTime()) ? d : null;
}

export function isOverdue(task, now = new Date()) {
  if (!task || task.done) return false;
  const d = dueDate(task);
  if (!d) return false;
  if (task.due_all_day) return startOfDay(d) < startOfDay(now);
  return d < now;
}

export function isDueToday(task, now = new Date()) {
  const d = dueDate(task);
  return !!d && sameDay(d, now);
}

/**
 * Filtros: 'today' (hoje + atrasadas), 'scheduled' (com prazo), 'flagged',
 * 'all' (pendentes), 'done', ou `list:<id>` / `list:0` (lista padrão).
 * Subtarefas (parent_id) não entram no topo — aparecem sob a mãe.
 */
export function filterTasks(tasks, filter, now = new Date()) {
  const top = (tasks || []).filter((t) => !t.parent_id);
  switch (filter) {
    case 'today': return top.filter((t) => !t.done && (isDueToday(t, now) || isOverdue(t, now)));
    case 'scheduled': return top.filter((t) => !t.done && !!t.due_at);
    case 'flagged': return top.filter((t) => !t.done && t.flagged);
    case 'done': return top.filter((t) => t.done).sort((a, b) => String(b.completed_at || b.updated_at || '').localeCompare(String(a.completed_at || a.updated_at || '')));
    case 'all': return top.filter((t) => !t.done);
    default: {
      if (String(filter).startsWith('list:')) {
        const id = Number(String(filter).slice(5)) || null;
        return top.filter((t) => !t.done && (t.list_id || null) === id);
      }
      return top.filter((t) => !t.done);
    }
  }
}

export function sortTasks(arr) {
  return [...arr].sort((a, b) => {
    const da = dueDate(a); const db = dueDate(b);
    if (da && db && da - db !== 0) return da - db;
    if (da && !db) return -1;
    if (!da && db) return 1;
    if ((b.priority || 0) !== (a.priority || 0)) return (b.priority || 0) - (a.priority || 0);
    if ((a.sort_order || 0) !== (b.sort_order || 0)) return (a.sort_order || 0) - (b.sort_order || 0);
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });
}

// Seções da visão "Programadas": atrasadas / hoje / amanhã / esta semana / depois.
export function scheduledSections(tasks, t, now = new Date()) {
  const tt = (k, fb) => (typeof t === 'function' && t(k)) || fb;
  const buckets = { overdue: [], today: [], tomorrow: [], week: [], later: [] };
  const tomorrow = addDays(startOfDay(now), 1);
  const weekEnd = addDays(startOfDay(now), 7);
  sortTasks(tasks).forEach((task) => {
    const d = dueDate(task);
    if (!d) return;
    if (isOverdue(task, now)) buckets.overdue.push(task);
    else if (sameDay(d, now)) buckets.today.push(task);
    else if (sameDay(d, tomorrow)) buckets.tomorrow.push(task);
    else if (d < weekEnd) buckets.week.push(task);
    else buckets.later.push(task);
  });
  return [
    { key: 'overdue', title: tt('tasks.section.overdue', 'Atrasadas'), data: buckets.overdue },
    { key: 'today', title: tt('tasks.section.today', 'Hoje'), data: buckets.today },
    { key: 'tomorrow', title: tt('tasks.section.tomorrow', 'Amanhã'), data: buckets.tomorrow },
    { key: 'week', title: tt('tasks.section.week', 'Próximos 7 dias'), data: buckets.week },
    { key: 'later', title: tt('tasks.section.later', 'Mais tarde'), data: buckets.later },
  ].filter((s) => s.data.length);
}

export function dueLabel(task, t, locale, now = new Date()) {
  const d = dueDate(task);
  if (!d) return '';
  const tt = (k, fb) => (typeof t === 'function' && t(k)) || fb;
  const time = task.due_all_day ? '' : ' ' + hhmm(d);
  if (sameDay(d, now)) return tt('tasks.today', 'Hoje') + time;
  if (sameDay(d, addDays(now, 1))) return tt('tasks.tomorrow', 'Amanhã') + time;
  if (sameDay(d, addDays(now, -1))) return tt('tasks.yesterday', 'Ontem') + time;
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  try {
    if (diff > 1 && diff < 7) return d.toLocaleDateString(locale || undefined, { weekday: 'long' }) + time;
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(locale || undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }) + time;
  } catch {
    return `${d.getDate()}/${d.getMonth() + 1}` + time;
  }
}

/**
 * Entrada rápida: "Pagar conta amanhã 10h !!" →
 * { title:'Pagar conta', due: Date|null, hasTime, priority: 2, flagged }
 * "!"/"!!"/"!!!" = prioridade; "#lista" é devolvido em `listHint`.
 */
export function parseTaskInput(text, now = new Date()) {
  let s = String(text || '').trim();
  if (!s) return null;
  let priority = 0;
  const pm = s.match(/(?:^|\s)(!{1,3})(?=\s|$)/);
  if (pm) { priority = pm[1].length; s = (s.slice(0, pm.index) + ' ' + s.slice(pm.index + pm[0].length)).trim(); }
  let listHint = '';
  const lm = s.match(/(?:^|\s)#([A-Za-z0-9\u00C0-\u024F_-]{1,40})/);
  if (lm) { listHint = lm[1]; s = (s.slice(0, lm.index) + ' ' + s.slice(lm.index + lm[0].length)).trim(); }
  const r = parseReminderDate(s, now);
  let title = s;
  let due = null; let hasTime = false;
  if (r && (r.hasDay || r.hasTime)) {
    due = r.date; hasTime = !!r.hasTime;
    title = stripDateWords(title);
    title = title.replace(/\s{2,}/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '').trim() || s;
    if (!hasTime) due.setHours(12, 0, 0, 0); // dia inteiro → meio-dia local (imune a fuso)
  }
  return { title: title.slice(0, 500), due, hasTime, priority, listHint };
}

// Prazo → servidor: dia inteiro manda a DATA local; com hora, ISO UTC.
export function dueToServer(d, allDay) {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return null;
  if (allDay) { const p = (n) => (n < 10 ? '0' + n : '' + n); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T12:00:00`; }
  return d.toISOString();
}

// Date local → ISO UTC p/ colunas timestamptz.
export function toIso(d) {
  return d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
