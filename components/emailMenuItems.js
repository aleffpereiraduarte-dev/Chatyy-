// [2026-10-09 more-native] Itens do menu de contexto de e-mail p/ o menu NATIVO
// do iOS (components/NativeContextMenu.js). Mesmas ações/ordem/rótulos do
// ContextMenu.js (sheet JS) — só que como UIMenu com SF Symbols.
// O EmailRow monta os itens; a inbox despacha a ação escolhida com o MESMO
// objeto `actions` que já entrega ao ContextMenu JS.

export function buildEmailNativeMenuActions(email, { t, isMuted } = {}) {
  if (!email || typeof t !== 'function') return [];
  const isRead = !!email.seen;
  const isStarred = !!email.flagged;
  return [
    { id: 'reply', title: t('contextMenu.reply'), systemImage: 'arrowshape.turn.up.left' },
    { id: 'replyAll', title: t('contextMenu.replyAll'), systemImage: 'arrowshape.turn.up.left.2' },
    { id: 'forward', title: t('contextMenu.forward'), systemImage: 'arrowshape.turn.up.right' },
    { id: isRead ? 'markUnread' : 'markRead', title: isRead ? t('contextMenu.markUnread') : t('contextMenu.markRead'), systemImage: isRead ? 'envelope.badge' : 'envelope.open' },
    { id: 'star', title: isStarred ? t('contextMenu.unstar') : t('contextMenu.star'), systemImage: isStarred ? 'star.slash' : 'star' },
    { id: 'snooze', title: t('contextMenu.snooze'), systemImage: 'clock' },
    { id: 'mute', title: isMuted ? t('contextMenu.unmute') : t('contextMenu.mute'), systemImage: isMuted ? 'bell' : 'bell.slash' },
    { id: 'moveTo', title: t('contextMenu.moveTo'), systemImage: 'folder' },
    { id: 'archive', title: t('contextMenu.archive'), systemImage: 'archivebox' },
    { id: 'spam', title: t('contextMenu.spam'), systemImage: 'exclamationmark.octagon', destructive: true },
    { id: 'delete', title: t('contextMenu.delete'), systemImage: 'trash', destructive: true },
  ];
}

const _MAP = {
  reply: 'onReply',
  replyAll: 'onReplyAll',
  forward: 'onForward',
  markRead: 'onMarkRead',
  markUnread: 'onMarkUnread',
  star: 'onStar',
  snooze: 'onSnooze',
  mute: 'onMute',
  moveTo: 'onMoveTo',
  archive: 'onArchive',
  spam: 'onSpam',
  delete: 'onDelete',
};

/** Roda a ação `id` com o objeto `actions` do ContextMenu (onReply, onDelete…). */
export function dispatchEmailMenuAction(id, email, actions) {
  const key = _MAP[id];
  const fn = key && actions ? actions[key] : null;
  if (typeof fn === 'function') {
    try { const r = fn(email); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch {}
    return true;
  }
  return false;
}
