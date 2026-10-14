// ============================================================
// NOTE REMINDERS — "Lembrar-me" nas Notas (nível Apple Notes / Google Keep)
// [notas-lembrete 2026-10-14]
//
// Fonte da verdade = SERVIDOR (api/note-reminders.php, tabela
// chat_note_reminders): o push sai do servidor na hora marcada, com o app
// fechado e em TODOS os aparelhos da conta. Hora gravada como hora de parede
// ("YYYY-MM-DDTHH:MM") + fuso IANA do aparelho (Intl) → repetição diária /
// semanal / mensal continua na mesma hora local (horário de verão incluso).
//
// Fallback OFFLINE (só nativo): sem rede / servidor fora → agenda notificação
// LOCAL no mesmo horário e enfileira a operação; quando o servidor aceita, a
// local é cancelada (nunca 2 avisos).
//
// Ações do push (categoria 'note_reminder'): Adiar 10 min / Adiar 1 h /
// Concluir — roteadas por services/pushNotifications.js.
// ============================================================
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const NOTE_REMINDER_TYPE = 'note_reminder';
export const NOTE_REMINDER_CATEGORY = 'note_reminder';
export const NOTE_REMINDER_ACTIONS = {
  SNOOZE_10: 'NOTE_SNOOZE_10',
  SNOOZE_60: 'NOTE_SNOOZE_60',
  DONE: 'NOTE_DONE',
};
export const NOTE_REMINDER_REPEATS = ['none', 'daily', 'weekly', 'monthly'];

const CACHE_KEY = 'chatyy_note_reminders_v1';      // última lista do servidor (chips instantâneos)
const PENDING_KEY = 'chatyy_note_reminders_pending_v1'; // operações feitas offline
const LOCAL_PREFIX = 'note-reminder-';
const DEFAULT_TZ = 'America/Sao_Paulo';

// ---- util ----------------------------------------------------------------
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);

export function deviceTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && typeof tz === 'string' ? tz : DEFAULT_TZ;
  } catch { return DEFAULT_TZ; }
}

/** Date → "YYYY-MM-DDTHH:MM" (hora de parede do aparelho). */
export function toLocalWall(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function atTime(base, days, h, m) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d;
}

/**
 * Atalhos estilo Keep. Só devolve os que ainda estão no futuro.
 * → [{ id: 'today'|'tomorrow'|'nextWeek', date }]
 */
export function reminderPresets(now = new Date()) {
  const out = [];
  const lead = now.getTime() + 60 * 1000;
  const today18 = atTime(now, 0, 18, 0);
  const tonight21 = atTime(now, 0, 21, 0);
  if (today18.getTime() > lead) out.push({ id: 'today', date: today18 });
  else if (tonight21.getTime() > lead) out.push({ id: 'today', date: tonight21 });
  out.push({ id: 'tomorrow', date: atTime(now, 1, 9, 0) });
  // próxima segunda 09:00 (se hoje é segunda → a da semana que vem)
  const dow = now.getDay(); // 0=dom
  const toMon = ((8 - dow) % 7) || 7;
  out.push({ id: 'nextWeek', date: atTime(now, toMon, 9, 0) });
  return out;
}

/** Instante do PRÓXIMO aviso (adiado > agendado); null = já disparou. */
export function reminderNextDate(rem) {
  if (!rem) return null;
  const iso = rem.next_at || rem.snooze_at || (rem.sent_at ? null : rem.fire_at);
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Data de referência para exibir (próximo aviso ou, se já disparou, o horário marcado). */
export function reminderDisplayDate(rem) {
  const n = reminderNextDate(rem);
  if (n) return n;
  const d = rem?.fire_at ? new Date(rem.fire_at) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

export function reminderIsOverdue(rem, now = Date.now()) {
  if (!rem) return false;
  const n = reminderNextDate(rem);
  return !n || n.getTime() < now - 60 * 1000;
}

const _tt = (t, k, p, fb) => { try { const v = t ? t(k, p) : null; return v && v !== k ? v : fb; } catch { return fb; } };

/**
 * Rótulo curto p/ chip: "Hoje, 18:00" / "Amanhã, 09:00" / "seg., 20 de out., 09:00".
 * Usa o locale do aparelho (Intl) p/ data; textos relativos via i18n.
 */
export function formatNoteReminderShort(date, t, now = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!d || isNaN(d.getTime())) return '';
  let time;
  try { time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); } catch { time = pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  const sod = (x) => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime(); };
  const diff = Math.round((sod(d) - sod(now)) / 86400000);
  if (diff === 0) return _tt(t, 'noteReminder.todayAt', { time }, `Hoje, ${time}`);
  if (diff === 1) return _tt(t, 'noteReminder.tomorrowAt', { time }, `Amanhã, ${time}`);
  if (diff === -1) return _tt(t, 'noteReminder.yesterdayAt', { time }, `Ontem, ${time}`);
  let ds;
  try {
    ds = d.toLocaleDateString(undefined, {
      weekday: diff > 1 && diff < 7 ? 'short' : undefined,
      day: 'numeric', month: 'short',
      year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  } catch { ds = pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1); }
  return `${ds}, ${time}`;
}

export function repeatLabel(repeat, t) {
  switch (repeat) {
    case 'daily': return _tt(t, 'noteReminder.repeatDaily', null, 'Diariamente');
    case 'weekly': return _tt(t, 'noteReminder.repeatWeekly', null, 'Semanalmente');
    case 'monthly': return _tt(t, 'noteReminder.repeatMonthly', null, 'Mensalmente');
    default: return '';
  }
}

// ---- estado em memória + assinantes --------------------------------------
let _map = null; // { [note_id]: reminder }
const _subs = new Set();
function _emit() { const snap = { ...(_map || {}) }; _subs.forEach((fn) => { try { fn(snap); } catch {} }); }
export function subscribeNoteReminders(fn) { _subs.add(fn); return () => _subs.delete(fn); }
export function getNoteRemindersSnapshot() { return { ...(_map || {}) }; }

async function _readJson(key, fb) {
  try { const raw = await AsyncStorage.getItem(key); const v = raw ? JSON.parse(raw) : fb; return v ?? fb; } catch { return fb; }
}
async function _writeJson(key, v) { try { await AsyncStorage.setItem(key, JSON.stringify(v)); } catch {} }

async function _ensureMap() {
  if (_map) return _map;
  const cached = await _readJson(CACHE_KEY, null);
  _map = cached && typeof cached === 'object' && !Array.isArray(cached) ? cached : {};
  return _map;
}
function _saveMap() { _writeJson(CACHE_KEY, _map || {}); }

function _api() { return require('./api'); }

// ---- notificação local (fallback offline, nativo) ---------------------------
let _N = null;
async function _notifications() {
  if (Platform.OS === 'web') return null;
  if (!_N) { try { _N = await import('expo-notifications'); } catch { _N = null; } }
  return _N;
}

async function _scheduleLocal(noteId, date, { title, body } = {}) {
  const N = await _notifications();
  if (!N || !(date instanceof Date) || date.getTime() < Date.now() + 5000) return false;
  try {
    const { ensureReminderChannel, REMINDER_CHANNEL } = require('./reminders');
    await ensureReminderChannel();
    const trigger = { type: 'date', date };
    if (Platform.OS === 'android') trigger.channelId = REMINDER_CHANNEL || 'reminders';
    await N.scheduleNotificationAsync({
      identifier: LOCAL_PREFIX + noteId,
      content: {
        title: title || 'Nota',
        body: body || '',
        sound: 'default',
        categoryIdentifier: NOTE_REMINDER_CATEGORY,
        data: { type: NOTE_REMINDER_TYPE, note_id: String(noteId), local: '1' },
        ...(Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL || 'reminders' } : {}),
      },
      trigger,
    });
    return true;
  } catch { return false; }
}

async function _cancelLocal(noteId) {
  const N = await _notifications();
  if (!N) return;
  try { await N.cancelScheduledNotificationAsync(LOCAL_PREFIX + noteId); } catch {}
}

// ---- fila offline -----------------------------------------------------------
async function _queue(op) {
  const q = await _readJson(PENDING_KEY, []);
  const list = Array.isArray(q) ? q.filter((x) => String(x.note_id) !== String(op.note_id)) : [];
  list.push({ ...op, queued_at: Date.now() });
  await _writeJson(PENDING_KEY, list.slice(-200));
}
async function _dequeue(noteId) {
  const q = await _readJson(PENDING_KEY, []);
  if (!Array.isArray(q) || !q.length) return;
  await _writeJson(PENDING_KEY, q.filter((x) => String(x.note_id) !== String(noteId)));
}

/** true = resposta do servidor é definitiva (sucesso ou erro de validação). */
function _isDefinitive(res) {
  if (!res || typeof res !== 'object') return false;
  if (res.success) return true;
  const code = res?.data?.code;
  return !!code && code !== 'unavailable';
}

async function _send(op) {
  const api = _api();
  if (op.kind === 'set') return api.apiCall('note_reminder_set', op.payload, 'POST');
  if (op.kind === 'clear') return api.apiCall('note_reminder_clear', { note_id: op.note_id }, 'POST');
  if (op.kind === 'snooze') return api.apiCall('note_reminder_snooze', { note_id: op.note_id, minutes: op.minutes }, 'POST');
  if (op.kind === 'done') return api.apiCall('note_reminder_done', { note_id: op.note_id }, 'POST');
  return null;
}

let _flushing = false;
/** Reenvia operações feitas offline (ordem preservada). Para na 1ª falha de rede. */
export async function flushPendingNoteReminders() {
  if (_flushing) return;
  _flushing = true;
  try {
    const q = await _readJson(PENDING_KEY, []);
    if (!Array.isArray(q) || !q.length) return;
    for (const op of q) {
      let res = null;
      try { res = await _send(op); } catch { res = null; }
      if (!_isDefinitive(res)) break;
      await _dequeue(op.note_id);
      await _cancelLocal(op.note_id); // o servidor assumiu → sem aviso duplicado
      await _ensureMap();
      if (op.kind === 'set' && res.success && res.data?.reminder) _map[String(op.note_id)] = res.data.reminder;
      if (op.kind === 'clear' || (op.kind === 'done' && res.success && !res.data?.reminder)) delete _map[String(op.note_id)];
      if (op.kind === 'set' && !res.success) delete _map[String(op.note_id)]; // ex.: nota apagada
      _saveMap(); _emit();
    }
  } finally { _flushing = false; }
}

// ---- API pública ------------------------------------------------------------
/** Lista do servidor (cache primeiro). Devolve o mapa { note_id: reminder }. */
export async function loadNoteReminders() {
  await _ensureMap();
  _emit();
  try {
    await flushPendingNoteReminders();
    const res = await _api().apiCall('note_reminder_list', {});
    if (res?.success && Array.isArray(res.data?.reminders)) {
      const pending = await _readJson(PENDING_KEY, []);
      const keep = {};
      if (Array.isArray(pending)) {
        for (const op of pending) { const k = String(op.note_id); if (op.kind === 'set' && _map[k]) keep[k] = _map[k]; }
      }
      const next = {};
      for (const r of res.data.reminders) { if (r && r.note_id != null) next[String(r.note_id)] = r; }
      if (Array.isArray(pending)) {
        for (const op of pending) { if (op.kind === 'clear') delete next[String(op.note_id)]; }
      }
      _map = { ...next, ...keep };
      _saveMap(); _emit();
    }
  } catch {}
  return { ...(_map || {}) };
}

export class NoteReminderError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'NoteReminderError'; }
}

/**
 * Pede permissão de notificação (e registra o token de push) se ainda não
 * decidido. → 'granted' | 'denied' | 'web'
 */
export async function ensureNoteReminderPermission() {
  const N = await _notifications();
  if (!N) return 'web';
  let status = 'undetermined';
  try { status = (await N.getPermissionsAsync())?.status || status; } catch {}
  if (status === 'granted') return 'granted';
  try { status = await require('./pushNotifications').enablePushFromPrimer(); } catch {}
  if (status !== 'granted') {
    try { status = (await N.getPermissionsAsync())?.status || status; } catch {}
  }
  return status === 'granted' ? 'granted' : 'denied';
}

/**
 * Cria/troca o lembrete da nota. `note` = { id, title, content } (título/corpo
 * só p/ o fallback local). Retorna o reminder (com `_offline: true` quando
 * ficou só no aparelho até voltar a rede). Lança NoteReminderError(code):
 * past | invalid_time | not_found | too_many | note_required.
 */
export async function setNoteReminder(note, date, repeat = 'none') {
  const noteId = note?.id;
  if (noteId == null || String(noteId).startsWith('local_')) throw new NoteReminderError('note_required');
  if (!(date instanceof Date) || isNaN(date.getTime())) throw new NoteReminderError('invalid_time');
  if (repeat === 'none' && date.getTime() < Date.now() + 30 * 1000) throw new NoteReminderError('past');
  const rep = NOTE_REMINDER_REPEATS.includes(repeat) ? repeat : 'none';
  const payload = { note_id: noteId, local: toLocalWall(date), tz: deviceTimeZone(), repeat: rep, fire_at: date.toISOString() };
  await _ensureMap();
  const k = String(noteId);
  const prev = _map[k];
  const optimistic = {
    note_id: Number(noteId) || noteId, fire_at: date.toISOString(), next_at: date.toISOString(),
    local: payload.local, tz: payload.tz, repeat: rep, state: 'scheduled', snooze_at: null, sent_at: null,
  };
  _map[k] = optimistic; _emit();
  let res = null;
  try { res = await _api().apiCall('note_reminder_set', payload, 'POST'); } catch { res = null; }
  if (res?.success && res.data?.reminder) {
    _map[k] = res.data.reminder; _saveMap(); _emit();
    await _dequeue(noteId); await _cancelLocal(noteId);
    return res.data.reminder;
  }
  if (_isDefinitive(res)) {
    if (prev) _map[k] = prev; else delete _map[k];
    _emit();
    throw new NoteReminderError(res?.data?.code || 'generic');
  }
  // sem servidor: aviso local no mesmo horário + fila
  const { title, body } = _localText(note);
  const scheduled = await _scheduleLocal(noteId, date, { title, body });
  await _queue({ kind: 'set', note_id: noteId, payload });
  _map[k] = { ...optimistic, _offline: true, _local: scheduled }; _saveMap(); _emit();
  return _map[k];
}

export async function clearNoteReminder(noteId) {
  if (noteId == null) return;
  await _ensureMap();
  const k = String(noteId);
  delete _map[k]; _emit();
  await _cancelLocal(noteId);
  let res = null;
  try { res = await _api().apiCall('note_reminder_clear', { note_id: noteId }, 'POST'); } catch { res = null; }
  if (_isDefinitive(res)) { await _dequeue(noteId); _saveMap(); return true; }
  await _queue({ kind: 'clear', note_id: noteId });
  _saveMap();
  return true;
}

/** Adiar (ação do push). Offline: aviso local em N minutos. */
export async function snoozeNoteReminder(noteId, minutes, { title, body } = {}) {
  if (noteId == null) return null;
  const mins = Math.max(1, Math.min(7 * 24 * 60, Number(minutes) || 10));
  let res = null;
  try { res = await _api().apiCall('note_reminder_snooze', { note_id: noteId, minutes: mins }, 'POST'); } catch { res = null; }
  await _ensureMap();
  if (res?.success && res.data?.reminder) { _map[String(noteId)] = res.data.reminder; _saveMap(); _emit(); return res.data.reminder; }
  if (_isDefinitive(res)) return null;
  await _scheduleLocal(noteId, new Date(Date.now() + mins * 60000), { title, body });
  await _queue({ kind: 'snooze', note_id: noteId, minutes: mins });
  return null;
}

/** Concluir (ação do push / botão). One-shot some; repetitivo segue a série. */
export async function completeNoteReminder(noteId) {
  if (noteId == null) return;
  await _cancelLocal(noteId);
  let res = null;
  try { res = await _api().apiCall('note_reminder_done', { note_id: noteId }, 'POST'); } catch { res = null; }
  await _ensureMap();
  const k = String(noteId);
  if (res?.success) {
    if (res.data?.reminder) _map[k] = res.data.reminder; else delete _map[k];
    _saveMap(); _emit(); return;
  }
  if (_isDefinitive(res)) return;
  const cur = _map[k];
  if (cur && (cur.repeat || 'none') === 'none') { delete _map[k]; _saveMap(); _emit(); }
  await _queue({ kind: 'done', note_id: noteId });
}

function _localText(note) {
  const lines = String(note?.content || '').split(/\r?\n/)
    .map((l) => l.trim().replace(/^(#{1,6}\s+|[-*+]\s+(\[[ xX]?\]\s*)?|\[[ xX]?\]\s*|>\s+|\d+[.)]\s+)/, '').trim())
    .filter(Boolean);
  let title = String(note?.title || '').trim();
  if (!title) title = lines.shift() || '';
  const body = lines.find((l) => l !== title) || '';
  return { title: title.slice(0, 80), body: body.slice(0, 140) };
}

// ---- categoria de ações (Adiar 10 min / Adiar 1 h / Concluir) ---------------
async function _labels() {
  let code = '';
  try { code = (await AsyncStorage.getItem('app_language_manual')) || ''; } catch {}
  if (!code) {
    try {
      const L = require('expo-localization');
      const l = L.getLocales?.()?.[0];
      code = l?.languageTag || l?.languageCode || '';
    } catch {}
  }
  let tr = null;
  try {
    const i18n = require('../i18n');
    const want = /^pt/i.test(code) ? (/pt-PT/i.test(code) ? 'pt-PT' : 'pt-BR') : String(code || 'en').split('-')[0];
    try { if (i18n.preloadLocale) await i18n.preloadLocale(want, 1500); } catch {}
    const chain = i18n.fallbackChain ? i18n.fallbackChain(want) : [want, 'en', 'pt-BR'];
    tr = (k) => { for (const c of chain) { const v = i18n.translations?.[c]?.[k]; if (typeof v === 'string') return v; } return null; };
  } catch {}
  const g = (k, fb) => (tr && tr(k)) || fb;
  return {
    s10: g('noteReminder.actionSnooze10', 'Adiar 10 min'),
    s60: g('noteReminder.actionSnooze60', 'Adiar 1 h'),
    done: g('noteReminder.actionDone', 'Concluir'),
  };
}

export async function registerNoteReminderCategory() {
  const N = await _notifications();
  if (!N?.setNotificationCategoryAsync) return;
  try {
    const L = await _labels();
    // opensAppToForeground: a ação precisa do JS vivo p/ chamar o servidor —
    // com o app morto, iOS/Android só garantem isso abrindo o app.
    await N.setNotificationCategoryAsync(NOTE_REMINDER_CATEGORY, [
      { identifier: NOTE_REMINDER_ACTIONS.SNOOZE_10, buttonTitle: L.s10, options: { opensAppToForeground: true } },
      { identifier: NOTE_REMINDER_ACTIONS.SNOOZE_60, buttonTitle: L.s60, options: { opensAppToForeground: true } },
      { identifier: NOTE_REMINDER_ACTIONS.DONE, buttonTitle: L.done, options: { opensAppToForeground: true } },
    ]);
  } catch {}
}

/**
 * Chamado por services/pushNotifications.js ao tocar num botão do push.
 * → true se tratou (não navega); false = deixa o toque abrir a nota.
 */
export async function handleNoteReminderAction(actionId, data, response) {
  const noteId = data?.note_id;
  if (noteId == null) return false;
  const content = response?.notification?.request?.content || {};
  const text = { title: content.title || '', body: content.body || '' };
  const dismiss = async () => {
    try {
      const N = await _notifications();
      const id = response?.notification?.request?.identifier;
      if (N && id) await N.dismissNotificationAsync(id);
    } catch {}
  };
  if (actionId === NOTE_REMINDER_ACTIONS.SNOOZE_10) { await dismiss(); await snoozeNoteReminder(noteId, 10, text); return true; }
  if (actionId === NOTE_REMINDER_ACTIONS.SNOOZE_60) { await dismiss(); await snoozeNoteReminder(noteId, 60, text); return true; }
  if (actionId === NOTE_REMINDER_ACTIONS.DONE) { await dismiss(); await completeNoteReminder(noteId); return true; }
  return false;
}

/** Boot (via meetingReminders.initMeetingReminders): categoria + reenvio do que ficou offline. */
export async function initNoteReminders() {
  await registerNoteReminderCategory();
  flushPendingNoteReminders().catch(() => {});
}
