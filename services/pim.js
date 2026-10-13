// ============================================================
// PIM — Calendário + Tarefas (2026-10-13)
//
// • Tarefas v2 (pim_task_* no servidor: listas, prioridade, subtarefas,
//   lembrete, sinalizada). Servidor antigo (sem pim.php) → cai nas actions
//   legadas task_* com o subconjunto que elas suportam (título/notas/prazo/
//   concluída) — o app funciona com servidor velho e novo.
// • Tempo real: o servidor emite `pim_changed` no canal chat_user_<email> do
//   hub WS (mesmo canal do "digitando") a cada mudança — vinda do app, da web
//   ou do iPhone via CalDAV. onPimChanged() junta isso + volta do background.
// • parseEventText(): "almoço com Ana sexta 13h no Outback" → evento. IA da
//   Bia (ai_extract_event) com contexto de data/fuso; sem rede/IA → parser
//   local (services/reminderParser).
// ============================================================
import { AppState, Platform } from 'react-native';
import * as api from './api';
import { getCachedSync, setCache } from './cache';
import { parseReminderDate, normalizeText } from './reminderParser';
import { dayKey, hhmm } from '../utils/calDate';
import { stripDateWords } from '../utils/taskUtils';

let _v2 = null; // null = ainda não sabe; true/false depois da 1ª chamada
const CACHE_KEY = 'pim_tasks_v2';

function _isUnknownAction(r) {
  const m = String(r?.message || r?.error || r?.data?.error || '');
  return /unknown action/i.test(m);
}

const _bool = (v) => v === true || v === 1 || v === '1' || v === 't' || v === 'true';
const _int = (v) => (v == null || v === '' ? null : (Number.isFinite(+v) ? +v : null));

export function normalizeTask(t) {
  if (!t) return null;
  return {
    id: _int(t.id),
    title: String(t.title || ''),
    notes: String(t.notes || ''),
    done: _bool(t.done),
    due_at: t.due_at || null,
    due_all_day: _bool(t.due_all_day),
    remind_at: t.remind_at || null,
    priority: _int(t.priority) || 0,
    flagged: _bool(t.flagged),
    list_id: _int(t.list_id),
    parent_id: _int(t.parent_id),
    sort_order: _int(t.sort_order) || 0,
    completed_at: t.completed_at || null,
    created_at: t.created_at || null,
    updated_at: t.updated_at || null,
    email_uid: t.email_uid || null,
    email_folder: t.email_folder || null,
    email_from: t.email_from || null,
  };
}

export function isTasksV2() { return _v2 === true; }

export function getCachedTasks() {
  try {
    if (!api.getActiveAccountEmail()) return null;
    const c = getCachedSync(CACHE_KEY);
    if (c && Array.isArray(c.tasks)) return c;
  } catch {}
  return null;
}

export async function fetchTasks() {
  if (_v2 !== false) {
    const r = await api.apiCall('pim_task_list', {});
    if (r?.success) {
      _v2 = true;
      const out = {
        tasks: (r.data?.tasks || []).map(normalizeTask).filter(Boolean),
        lists: (r.data?.lists || []).map((l) => ({ id: _int(l.id), name: String(l.name || ''), color: l.color || '#111111', sort_order: _int(l.sort_order) || 0 })),
        v2: true,
      };
      setCache(CACHE_KEY, out).catch(() => {});
      return out;
    }
    if (_isUnknownAction(r)) _v2 = false;
    else throw new Error(r?.message || 'load_failed');
  }
  const r = await api.taskList('all');
  if (!r?.success) throw new Error(r?.message || 'load_failed');
  const out = { tasks: (r.data?.tasks || []).map(normalizeTask).filter(Boolean), lists: [], v2: false };
  setCache(CACHE_KEY, out).catch(() => {});
  return out;
}

const LEGACY_FIELDS = ['title', 'notes', 'done', 'due_at'];
function _legacyPick(fields) {
  const o = {};
  LEGACY_FIELDS.forEach((k) => { if (k in fields) o[k] = fields[k]; });
  return o;
}

export async function createTask(fields) {
  if (_v2 !== false) {
    const r = await api.apiCall('pim_task_create', fields, 'POST');
    if (r?.success) { _v2 = true; return normalizeTask(r.data?.task); }
    if (!_isUnknownAction(r)) throw new Error(r?.message || 'create_failed');
    _v2 = false;
  }
  const r = await api.taskCreate(_legacyPick(fields));
  if (!r?.success) throw new Error(r?.message || 'create_failed');
  return normalizeTask(r.data?.task);
}

export async function updateTask(id, fields) {
  if (_v2 !== false) {
    const r = await api.apiCall('pim_task_update', { id, ...fields }, 'POST');
    if (r?.success) { _v2 = true; return normalizeTask(r.data?.task); }
    if (!_isUnknownAction(r)) throw new Error(r?.message || 'update_failed');
    _v2 = false;
  }
  const pick = _legacyPick(fields);
  if (!Object.keys(pick).length) return null;
  const r = await api.taskUpdate(id, pick);
  if (!r?.success) throw new Error(r?.message || 'update_failed');
  return normalizeTask(r.data?.task);
}

export async function deleteTask(id) {
  if (_v2 !== false) {
    const r = await api.apiCall('pim_task_delete', { id }, 'POST');
    if (r?.success) { _v2 = true; return true; }
    if (!_isUnknownAction(r)) throw new Error(r?.message || 'delete_failed');
    _v2 = false;
  }
  const r = await api.taskDelete(id);
  if (!r?.success) throw new Error(r?.message || 'delete_failed');
  return true;
}

export async function createList(name, color) {
  const r = await api.apiCall('pim_list_create', { name, color }, 'POST');
  if (!r?.success) throw new Error(r?.message || 'list_failed');
  return r.data?.list;
}
export async function updateList(id, fields) {
  const r = await api.apiCall('pim_list_update', { id, ...fields }, 'POST');
  if (!r?.success) throw new Error(r?.message || 'list_failed');
  return r.data?.list;
}
export async function deleteList(id) {
  const r = await api.apiCall('pim_list_delete', { id }, 'POST');
  if (!r?.success) throw new Error(r?.message || 'list_failed');
  return true;
}

// ---- CalDAV / sincronização com o aparelho ------------------------------
export async function davInfo() {
  const r = await api.apiCall('pim_dav_info', {});
  if (r?.success) return r.data || null;
  if (_isUnknownAction(r)) return { available: false };
  throw new Error(r?.message || 'dav_failed');
}
export async function davCreatePassword(label) {
  const r = await api.apiCall('pim_dav_password_create', { label }, 'POST');
  if (!r?.success) throw new Error(r?.message || 'dav_failed');
  return r.data;
}
export async function davRevokePassword(id) {
  const r = await api.apiCall('pim_dav_password_revoke', { id }, 'POST');
  if (!r?.success) throw new Error(r?.message || 'dav_failed');
  return true;
}
export async function davProfileLink(label) {
  const r = await api.apiCall('pim_dav_profile_link', { label }, 'POST');
  if (!r?.success) throw new Error(r?.message || 'dav_failed');
  return r.data;
}

// Fuso do aparelho → servidor (CalDAV gera TZID certo; 1x por sessão).
let _tzSent = false;
export function reportTimezone() {
  if (_tzSent) return;
  _tzSent = true;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) api.apiCall('pim_tz_set', { tz }, 'POST').catch(() => {});
  } catch {}
}

// ---- tempo real ----------------------------------------------------------
/**
 * onPimChanged(cb) → unsubscribe. cb({ kind: 'task'|'list'|'event'|'*', op, id, origin }).
 * Fontes: frame WS `pim_changed` + app voltando ao primeiro plano + poll de
 * segurança (90s) enquanto inscrito.
 */
export function onPimChanged(cb, { pollMs = 90000 } = {}) {
  const offs = [];
  try {
    const ws = require('./websocket').default;
    if (ws && typeof ws.on === 'function') {
      offs.push(ws.on('pim_changed', (d) => { try { cb(d || { kind: '*' }); } catch {} }));
    }
  } catch {}
  try {
    let last = AppState.currentState;
    const sub = AppState.addEventListener('change', (s) => {
      if (last !== 'active' && s === 'active') { try { cb({ kind: '*', op: 'foreground' }); } catch {} }
      last = s;
    });
    offs.push(() => { try { sub.remove(); } catch {} });
  } catch {}
  if (Platform.OS === 'web' && typeof document !== 'undefined') {
    const h = () => { if (document.visibilityState === 'visible') { try { cb({ kind: '*', op: 'foreground' }); } catch {} } };
    document.addEventListener('visibilitychange', h);
    offs.push(() => document.removeEventListener('visibilitychange', h));
  }
  if (pollMs > 0) {
    const iv = setInterval(() => {
      if (AppState.currentState === 'active' || Platform.OS === 'web') { try { cb({ kind: '*', op: 'poll' }); } catch {} }
    }, pollMs);
    offs.push(() => clearInterval(iv));
  }
  return () => offs.forEach((f) => { try { f && f(); } catch {} });
}

// ---- linguagem natural → evento -----------------------------------------
const WEEKDAYS_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

function _parseAiDate(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return { date: new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, 0, 0), hasTime: !!m[4] };
}

// Tira do texto as expressões de data/hora e o "no <Lugar>" final p/ sobrar o título.
export function localEventGuess(text, now = new Date()) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const when = parseReminderDate(raw, now);
  let location = '';
  const locM = raw.match(/\s(?:no|na|em|at|en)\s+([A-ZÀ-Ý0-9][^,.;]{1,60})$/);
  let rest = raw;
  if (locM) { location = locM[1].trim(); rest = raw.slice(0, locM.index); }
  rest = stripDateWords(rest);
  let title = rest.replace(/\s{2,}/g, ' ').replace(/^[\s,.-]+|[\s,.-]+$/g, '').trim();
  if (!title) title = raw;
  title = title.charAt(0).toUpperCase() + title.slice(1);
  let start = when?.date || null;
  const hasTime = !!when?.hasTime;
  const allDay = !!start && !hasTime && !!when?.hasDay;
  if (start && allDay) start.setHours(0, 0, 0, 0);
  const end = start ? new Date(start.getTime() + 60 * 60000) : null;
  return { title: title.slice(0, 120), location, start, end, allDay, source: 'local' };
}

/**
 * parseEventText(text) → { title, location, start: Date|null, end: Date|null, allDay, source: 'ai'|'local' }
 * Tenta a Bia (6s); se falhar ou não achar data, usa o parser local.
 */
export async function parseEventText(text, now = new Date()) {
  const local = localEventGuess(text, now);
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  const ctx = `[Contexto: hoje é ${WEEKDAYS_PT[now.getDay()]}, ${dayKey(now)} ${hhmm(now)}${tz ? ', fuso ' + tz : ''}. Datas relativas ("sexta", "amanhã") são a partir de hoje, sempre no futuro. Responda com hora local.] `;
  try {
    const r = await Promise.race([
      api.aiExtractEvent(ctx + String(text).slice(0, 400)),
      new Promise((res) => setTimeout(() => res(null), 6000)),
    ]);
    const d = r?.success ? r.data : null;
    const s = _parseAiDate(d?.start);
    if (d && s && s.date.getTime() > now.getTime() - 12 * 3600000) {
      const e = _parseAiDate(d.end);
      const allDay = !s.hasTime;
      const end = e && e.date > s.date ? e.date : new Date(s.date.getTime() + 60 * 60000);
      return {
        title: String(d.title || local?.title || text).slice(0, 120),
        location: String(d.location || local?.location || '').slice(0, 200),
        description: d.description ? String(d.description).slice(0, 1000) : '',
        start: s.date, end, allDay, source: 'ai',
      };
    }
  } catch {}
  return local;
}

// "Parece um evento?" — usado p/ detectar datas em e-mails sem chamar IA.
export function detectEventInText(text, now = new Date()) {
  const s = String(text || '').slice(0, 1500);
  if (s.length < 6) return null;
  const r = parseReminderDate(s, now);
  if (!r || !r.hasDay || !r.hasTime || r.past) return null;
  // Evita falso-positivo com "em 2h" relativo (não é compromisso).
  if (r.source === 'relative') return null;
  // Exige uma pista de compromisso ou data explícita.
  const n = normalizeText(s);
  if (!/(reuniao|encontro|evento|consulta|entrevista|almoco|jantar|cafe|aula|webinar|call|meeting|appointment|interview|lunch|dinner|reunion|cita|\d{1,2}\/\d{1,2}|dia \d|segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|monday|tuesday|wednesday|thursday|friday|tomorrow)/.test(n)) return null;
  return r.date;
}
