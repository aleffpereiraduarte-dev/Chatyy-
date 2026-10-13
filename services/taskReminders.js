// ============================================================
// Lembretes LOCAIS das tarefas (2026-10-13)
//
// Cada tarefa pendente com `remind_at` (ou prazo com hora) vira uma
// notificação local agendada (identifier `task-<id>`), reconciliada sempre
// que a lista muda (abrir a tela, frame `pim_changed` vindo da web/iPhone,
// volta do background). Funciona offline e sem push. iOS guarda no máx. 64
// pendentes no total → agendamos só as 40 mais próximas (sobra espaço p/
// lembretes do chat/reuniões); as demais entram na próxima reconciliação.
// Web: no-op (lá o lembrete vem do servidor/calendário).
// ============================================================
import { Platform } from 'react-native';
import { parseCalDate } from '../utils/calDate';
import { ensureReminderChannel, ensureNotificationPermission, REMINDER_CHANNEL } from './reminders';

const PREFIX = 'task-';
const MAX_SCHEDULED = 40;
const MIN_LEAD_MS = 5000;

let N = null;
async function loadN() {
  if (Platform.OS === 'web') return null;
  if (!N) { try { N = await import('expo-notifications'); } catch { N = null; } }
  return N;
}

export function taskReminderTime(task) {
  if (!task || task.done) return null;
  if (task.remind_at) {
    const d = parseCalDate(task.remind_at);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }
  if (task.due_at && !task.due_all_day) {
    const d = parseCalDate(task.due_at);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }
  return null;
}

let _running = null;
/**
 * syncTaskReminders(tasks, { ask }) — agenda/cancela p/ bater com a lista.
 * ask=true pede permissão de notificação se ainda não decidida (use quando o
 * usuário acabou de pôr um lembrete); false = só agenda se já permitido.
 */
export async function syncTaskReminders(tasks, { ask = false, t } = {}) {
  if (Platform.OS === 'web') return { scheduled: 0 };
  if (_running) { try { await _running; } catch {} }
  _running = (async () => {
    const Notif = await loadN();
    if (!Notif) return { scheduled: 0 };
    let status = 'undetermined';
    try { status = (await Notif.getPermissionsAsync())?.status || 'undetermined'; } catch {}
    if (status !== 'granted') {
      if (!ask) return { scheduled: 0, permission: status };
      const p = await ensureNotificationPermission();
      if (p !== 'granted') return { scheduled: 0, permission: 'denied' };
    }
    await ensureReminderChannel();
    const now = Date.now();
    const wanted = new Map();
    (tasks || [])
      .map((tk) => ({ tk, at: taskReminderTime(tk) }))
      .filter((x) => x.at && x.at > now + MIN_LEAD_MS && x.tk.id)
      .sort((a, b) => a.at - b.at)
      .slice(0, MAX_SCHEDULED)
      .forEach((x) => wanted.set(PREFIX + x.tk.id, x));

    let pending = [];
    try { pending = await Notif.getAllScheduledNotificationsAsync(); } catch {}
    const have = new Map();
    (pending || []).forEach((p) => {
      const id = p?.identifier || '';
      if (id.startsWith(PREFIX)) have.set(id, p);
    });
    // cancela o que não deve mais existir ou mudou (hora/título)
    for (const [id, p] of have) {
      const w = wanted.get(id);
      const d = p?.content?.data || {};
      if (!w || Number(d.when) !== w.at || d.title !== w.tk.title) {
        try { await Notif.cancelScheduledNotificationAsync(id); } catch {}
        have.delete(id);
      }
    }
    let scheduled = 0;
    for (const [id, w] of wanted) {
      if (have.has(id)) continue;
      const tt = typeof t === 'function' ? t : null;
      const body = w.tk.notes
        ? String(w.tk.notes).slice(0, 140)
        : ((tt && tt('tasks.reminderBody')) || 'Lembrete de tarefa');
      const trigger = { type: 'date', date: new Date(w.at) };
      if (Platform.OS === 'android') trigger.channelId = REMINDER_CHANNEL;
      try {
        await Notif.scheduleNotificationAsync({
          identifier: id,
          content: {
            title: w.tk.title || 'Tarefa',
            body,
            sound: 'default',
            data: { type: 'task_reminder', task_id: String(w.tk.id), when: w.at, title: w.tk.title },
            ...(Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL } : {}),
          },
          trigger,
        });
        scheduled++;
      } catch {}
    }
    return { scheduled, total: wanted.size };
  })();
  try { return await _running; } finally { _running = null; }
}

export async function cancelTaskReminder(id) {
  const Notif = await loadN();
  if (!Notif) return;
  try { await Notif.cancelScheduledNotificationAsync(PREFIX + id); } catch {}
}
