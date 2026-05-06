// Send-fail event bus — lets offlineCache notify chat-conversation when a
// queued action has been retrying for so long it should flip to a red ❗
// failed-state in the UI. The action stays in the queue (next foreground /
// reconnect / explicit retry will try again), but the user gets a visible
// signal instead of seeing "pending" forever.

const _listeners = new Set();

export function onSendFail(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function emitSendFail(conversationId, tempId, clientMessageId) {
  for (const fn of _listeners) {
    try { fn({ conversationId, tempId, clientMessageId }); } catch {}
  }
}
