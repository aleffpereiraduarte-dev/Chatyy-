// [2026-10-07 email-instant-send] Gmail-style send: the composer closes
// immediately after the server queues the message (it holds it for the
// undo window via send_id), and a global "Enviando… Desfazer" bar lives
// outside the composer. Undo cancels server-side and reopens the composer
// with the same content (restore payload kept in memory only).
let _state = null;      // { sid, until, restore }
let _restore = null;    // payload waiting for the reopened composer
let _timer = null;
const _subs = new Set();

function _emit() { _subs.forEach((fn) => { try { fn(_state); } catch {} }); }

export function subscribeEmailUndo(fn) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

export function getEmailUndo() { return _state; }

export function startEmailUndo({ sid, seconds, restore }) {
  if (_timer) clearTimeout(_timer);
  _state = { sid, until: Date.now() + Math.max(1, seconds) * 1000, restore: restore || null, phase: 'pending' };
  _emit();
  _timer = setTimeout(() => {
    _state = _state && _state.sid === sid ? { ..._state, phase: 'sent' } : _state;
    _emit();
    _timer = setTimeout(() => { if (_state && _state.sid === sid) { _state = null; _emit(); } }, 1800);
  }, Math.max(1, seconds) * 1000);
}

// Returns true when the cancel request was issued (still inside the window).
export async function undoEmailSend() {
  const st = _state;
  if (!st || st.phase !== 'pending' || Date.now() > st.until) return false;
  if (_timer) clearTimeout(_timer);
  _state = null;
  _emit();
  try {
    const api = require('./api');
    await api.cancelSend?.(st.sid);
  } catch {}
  _restore = st.restore;
  return true;
}

export function dismissEmailUndo() {
  if (_timer) clearTimeout(_timer);
  _state = null;
  _emit();
}

// Composer calls this on mount when opened with ?restore_undo=1.
export function takeEmailUndoRestore() {
  const r = _restore;
  _restore = null;
  return r;
}
