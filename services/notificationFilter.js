// [2026-10-14 notif-no-email] A central de Notificações é só chat/social.
// E-mails (type 'email', alertas do One sobre e-mail 'one_alert', ou qualquer
// linha que aponte p/ uma mensagem IMAP via data.uid+folder) ficam de fora —
// eles já têm a caixa de entrada. Servidor ainda devolve essas linhas em
// email.php notifications_list / notifications_unread_count (chat_notifications.type).
const EMAIL_TYPES = new Set(['email', 'one_alert', 'mail', 'email_digest']);

function _data(n) {
  let d = n && n.data;
  if (typeof d === 'string') { try { d = JSON.parse(d || '{}'); } catch { d = {}; } }
  return d || {};
}

export function isEmailNotification(n) {
  if (!n) return false;
  const type = String(n.type || '').toLowerCase();
  if (EMAIL_TYPES.has(type) || type.startsWith('email')) return true;
  const d = _data(n);
  if (d.uid != null && (d.folder || d.mailbox)) return true;
  return false;
}

export function filterSocialNotifications(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((n) => !isEmailNotification(n));
}
