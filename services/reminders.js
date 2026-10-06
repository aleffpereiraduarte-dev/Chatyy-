// ============================================================
// CHAT REMINDERS — "Criar lembrete" smart action.
//
// Native: schedules a LOCAL notification (expo-notifications, OS-level —
// fires with the app killed) + persists the record in AsyncStorage so we can
// list/cancel/re-schedule after a reinstall of the notification store.
// Web: no reliable local scheduling → saves a calendar event with
// reminder_minutes=0 (backend cron `calendar.php --fire-reminders` pushes).
//
// Every failure THROWS a ReminderError with a `code` the UI maps to a
// human message — never silent (that was the founder's complaint).
// ============================================================
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { detectReminder, parseReminderDate, hasReminderIntent } from './reminderParser';

export { detectReminder, parseReminderDate, hasReminderIntent };
// [2026-10-06 HOTFIX P0] ReminderSheet importa REMINDER_DEFAULTS DAQUI; faltava
// re-exportar → undefined.evening → crash "Algo deu errado" em TODA conversa
// (o sheet é montado sempre). Print do founder 07:36.
export { REMINDER_DEFAULTS } from './reminderParser';

const STORE_KEY = 'chatyy_chat_reminders_v1';
const ID_PREFIX = 'chat-reminder-';
export const REMINDER_CHANNEL = 'reminders';
const MIN_LEAD_MS = 5000;

export class ReminderError extends Error {
  constructor(code, message) { super(message || code); this.code = code; this.name = 'ReminderError'; }
}

let Notifications = null;
async function loadNotifications() {
  if (Platform.OS === 'web') return null;
  if (!Notifications) Notifications = await import('expo-notifications');
  return Notifications;
}

// ---- storage -------------------------------------------------------------
async function readStore() {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
async function writeStore(list) {
  try { await AsyncStorage.setItem(STORE_KEY, JSON.stringify(list.slice(-200))); } catch {}
}

export async function listReminders({ accountEmail } = {}) {
  const all = await readStore();
  const now = Date.now();
  const acct = (accountEmail || '').toLowerCase();
  return all
    .filter(r => r && r.when > now - 60000)
    .filter(r => !acct || !r.account || r.account === acct)
    .sort((a, b) => a.when - b.when);
}

// ---- permissions ---------------------------------------------------------
/**
 * ensureNotificationPermission() → 'granted' | 'denied' | 'web'
 * Asks when undetermined. On iOS a previously-denied status can't be
 * re-prompted → caller offers Linking.openSettings().
 */
export async function ensureNotificationPermission() {
  const N = await loadNotifications();
  if (!N) return 'web';
  let status = 'undetermined';
  try { status = (await N.getPermissionsAsync())?.status || 'undetermined'; } catch {}
  if (status === 'granted') return 'granted';
  try {
    const r = await N.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
    status = r?.status || status;
  } catch {}
  return status === 'granted' ? 'granted' : 'denied';
}

export async function ensureReminderChannel() {
  if (Platform.OS !== 'android') return;
  try {
    const N = await loadNotifications();
    if (!N) return;
    await N.setNotificationChannelAsync(REMINDER_CHANNEL, {
      name: 'Lembretes',
      importance: N.AndroidImportance.MAX,
      vibrationPattern: [0, 300, 200, 300],
      sound: 'default',
      lockscreenVisibility: N.AndroidNotificationVisibility?.PUBLIC,
      bypassDnd: false,
    });
  } catch {}
}

// ---- scheduling ----------------------------------------------------------
function buildContent(rec, title) {
  return {
    title: title || 'Lembrete',
    body: rec.text || '',
    sound: 'default',
    data: {
      type: 'chat_reminder',
      reminder_id: rec.id,
      conversation_id: rec.conversationId != null ? String(rec.conversationId) : undefined,
      message_id: rec.messageId != null ? String(rec.messageId) : undefined,
      sender_name: rec.conversationName || '',
      is_group: rec.conversationType === 'group' ? '1' : '0',
      recipient_email: rec.account || undefined,
    },
    ...(Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL } : {}),
  };
}

async function scheduleNative(rec, title) {
  const N = await loadNotifications();
  if (!N) throw new ReminderError('unsupported');
  await ensureReminderChannel();
  const trigger = { type: 'date', date: new Date(rec.when) };
  if (Platform.OS === 'android') trigger.channelId = REMINDER_CHANNEL;
  await N.scheduleNotificationAsync({ identifier: rec.id, content: buildContent(rec, title), trigger });
}

function localSqlDate(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

async function scheduleWebViaCalendar(rec, title) {
  const api = require('./api');
  const r = await api.calCreateEvent({
    title: (rec.text || title || 'Lembrete').slice(0, 120),
    description: (rec.conversationName ? `Lembrete do chat com ${rec.conversationName}` : 'Lembrete do chat') + (rec.text ? `\n\n${rec.text}` : ''),
    location: '',
    start_at: localSqlDate(rec.when),
    end_at: localSqlDate(rec.when + 30 * 60000),
    all_day: false,
    color: '#f59e0b',
    reminder_minutes: 0,
  });
  if (!r || !r.success) throw new ReminderError('backend', r?.message || 'Falha ao salvar no calendário');
  return r.data?.event?.id || r.data?.id || null;
}

/**
 * createReminder({ text, when, conversationId, conversationName,
 *                  conversationType, messageId, accountEmail, title })
 * → record. Throws ReminderError(code): 'past' | 'permission' | 'unsupported' | 'backend' | 'schedule'
 */
export async function createReminder(opts) {
  const when = opts?.when instanceof Date ? opts.when.getTime() : Number(opts?.when);
  if (!Number.isFinite(when)) throw new ReminderError('invalid');
  if (when < Date.now() + MIN_LEAD_MS) throw new ReminderError('past');
  const text = String(opts.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const rec = {
    id: ID_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    text,
    when,
    conversationId: opts.conversationId ?? null,
    conversationName: opts.conversationName || '',
    conversationType: opts.conversationType || 'direct',
    messageId: opts.messageId ?? null,
    account: (opts.accountEmail || '').toLowerCase() || null,
    createdAt: Date.now(),
    platform: Platform.OS,
  };

  if (Platform.OS === 'web') {
    rec.calendarEventId = await scheduleWebViaCalendar(rec, opts.title);
  } else {
    const perm = await ensureNotificationPermission();
    if (perm !== 'granted') throw new ReminderError('permission');
    try {
      await scheduleNative(rec, opts.title);
    } catch (e) {
      if (e instanceof ReminderError) throw e;
      throw new ReminderError('schedule', e?.message || String(e));
    }
    // Verify the OS really accepted it (iOS silently drops >64 pending).
    try {
      const N = await loadNotifications();
      const pending = await N.getAllScheduledNotificationsAsync();
      if (Array.isArray(pending) && pending.length && !pending.some(p => p?.identifier === rec.id)) {
        throw new ReminderError('schedule', 'not pending after schedule');
      }
    } catch (e) { if (e instanceof ReminderError) throw e; }
  }

  const list = await readStore();
  list.push(rec);
  await writeStore(list);
  return rec;
}

export async function cancelReminder(id) {
  const list = await readStore();
  const rec = list.find(r => r.id === id);
  try {
    const N = await loadNotifications();
    if (N) await N.cancelScheduledNotificationAsync(id);
  } catch {}
  if (rec?.calendarEventId) {
    try { await require('./api').calDeleteEvent(rec.calendarEventId); } catch {}
  }
  await writeStore(list.filter(r => r.id !== id));
}

/**
 * Re-arm anything the OS lost (reinstall / Android "clear data" / rare drop)
 * and prune fired reminders. Called at boot from meetingReminders.init.
 */
export async function reconcileReminders() {
  if (Platform.OS === 'web') return;
  try {
    const list = await readStore();
    if (!list.length) return;
    const now = Date.now();
    const keep = list.filter(r => r && r.when > now - 60000);
    const N = await loadNotifications();
    if (!N) return;
    let pending = [];
    try { pending = await N.getAllScheduledNotificationsAsync(); } catch {}
    const ids = new Set((pending || []).map(p => p?.identifier));
    for (const r of keep) {
      if (r.when > now + MIN_LEAD_MS && !ids.has(r.id)) {
        try { await scheduleNative(r); } catch {}
      }
    }
    if (keep.length !== list.length) await writeStore(keep);
  } catch {}
}

export async function initChatReminders() {
  await ensureReminderChannel();
  await reconcileReminders();
}

// ---- formatting ----------------------------------------------------------
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
/**
 * formatReminderWhen(date, t, now?) → "amanhã às 08:00" / "hoje às 20:00" /
 * "sex às 09:00" / "20/10 às 14:00". `t` is the i18n function.
 */
export function formatReminderWhen(date, t, now = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const sod = x => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime(); };
  const dayDiff = Math.round((sod(d) - sod(now)) / 86400000);
  const tt = (k, p, fb) => { const v = t ? t(k, p) : null; return v && v !== k ? v : fb; };
  if (dayDiff === 0) return tt('reminder.whenToday', { time }, `hoje às ${time}`);
  if (dayDiff === 1) return tt('reminder.whenTomorrow', { time }, `amanhã às ${time}`);
  if (dayDiff > 1 && dayDiff < 7) {
    let days = t ? t('time.days') : null;
    if (!Array.isArray(days) || days.length !== 7) days = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
    return tt('reminder.whenDate', { date: days[d.getDay()], time }, `${days[d.getDay()]} às ${time}`);
  }
  const ds = pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1);
  return tt('reminder.whenDate', { date: ds, time }, `${ds} às ${time}`);
}

/** Map a thrown ReminderError to an i18n key the UI can show. */
export function reminderErrorKey(err) {
  const code = err?.code;
  if (code === 'past') return 'reminder.errPast';
  if (code === 'permission') return 'reminder.errPermission';
  if (code === 'unsupported') return 'reminder.errUnsupported';
  if (code === 'backend') return 'reminder.errBackend';
  return 'reminder.errGeneric';
}
