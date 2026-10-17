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
  // [2026-10-15 email-melhorias] Só reabre o composer se o servidor
  // CONFIRMAR o cancelamento. Antes o resultado era ignorado: se o envio já
  // tinha saído (janela fechou no servidor / 404 "ja foi enviado") ou a rede
  // falhou, o composer reabria como se tivesse desfeito — o usuário
  // reenviava e o destinatário recebia 2×.
  let cancelled = false;
  try {
    const api = require('./api');
    const r = await api.cancelSend?.(st.sid);
    cancelled = !!(r && r.success && (r.data?.cancelled !== false));
  } catch {}
  if (!cancelled) {
    try { showEmailNotice('sent'); } catch {}
    return false;
  }
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

// [2026-10-08 email-outbox] Non-undoable notices on the same global bar:
//   'outbox' → "Na caixa de saída" (offline / waiting upload / network error)
//   'sending'→ "Enviando…" while attachments finish uploading (no Undo yet;
//              the outbox drain swaps in the real Undo bar once queued)
//   'sent'   → "E-mail enviado" (an outbox entry went out later)
export function showEmailNotice(kind) {
  if (_state && _state.phase === 'pending') return; // never hide a live Undo
  // [2026-10-17 email-send-gmail] a "Não enviada · Tentar de novo" stays put
  // until the user acts or it times out — a late 'outbox' notice for another
  // entry must not wipe it.
  if (_state && _state.phase === 'failed' && kind === 'outbox') return;
  if (_timer) clearTimeout(_timer);
  const phase = kind === 'outbox' ? 'outbox' : kind === 'sending' ? 'sending' : 'sent';
  _state = { sid: null, until: Date.now(), restore: null, phase };
  _emit();
  const mine = _state;
  _timer = setTimeout(() => { if (_state === mine) { _state = null; _emit(); } }, phase === 'sending' ? 60000 : phase === 'outbox' ? 5000 : 2500);
}

// Outbox "Editar": hand a restore payload to the composer opened with
// ?restore_undo=1 (same channel the Undo uses).
export function setEmailComposeRestore(r) {
  _restore = r || null;
}

// [2026-10-17 email-send-gmail] "Não enviada · Tentar de novo": the outbox
// calls this when a send fails (hard error, lost attachment, or the first
// network failure of a fresh send). The message stays in the outbox (draft
// preserved); the bar's button retries that entry (`csid`).
export function showEmailFailed(csid) {
  if (_state && _state.phase === 'pending') return;
  if (_timer) clearTimeout(_timer);
  _state = { sid: null, csid: csid || null, until: Date.now(), restore: null, phase: 'failed' };
  _emit();
  const mine = _state;
  _timer = setTimeout(() => { if (_state === mine) { _state = null; _emit(); } }, 12000);
}
