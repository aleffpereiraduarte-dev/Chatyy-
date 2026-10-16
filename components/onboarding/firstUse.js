// [2026-10-16 wave12-c] "1º uso real" por conta — gate para tudo que NÃO deve
// aparecer por cima do primeiro contato com o app (ex.: tour Plus).
//
// Considera que o 1º uso já aconteceu quando:
//   • a conta mandou 1 mensagem com sucesso neste aparelho (barramento '*' do
//     services/messageOutbox: estado sent/delivered/read), OU
//   • a home de Conversas foi aberta em 3 sessões diferentes (1 por processo);
// e, em qualquer caso, o first-run (services/firstRun.js) não está pendente.
//
// Estado em AsyncStorage `chatyy_first_use_v1:<email>` = { opens, sent }.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'chatyy_first_use_v1:';
export const FIRST_USE_OPENS = 3;

const _openedThisProcess = new Set(); // e-mails já contados nesta sessão do app

function _k(email) { return KEY + String(email || '').trim().toLowerCase(); }

async function _read(email) {
  try {
    const raw = await AsyncStorage.getItem(_k(email));
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : { opens: 0, sent: false };
  } catch { return { opens: 0, sent: false }; }
}

async function _write(email, v) {
  try { await AsyncStorage.setItem(_k(email), JSON.stringify({ opens: Number(v.opens) || 0, sent: !!v.sent })); } catch {}
}

/** Conta 1 abertura da home (no máximo 1 por processo/conta). */
export async function noteHomeOpen(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return null;
  const cur = await _read(em);
  if (_openedThisProcess.has(em)) return cur;
  _openedThisProcess.add(em);
  const next = { opens: (Number(cur.opens) || 0) + 1, sent: !!cur.sent };
  await _write(em, next);
  return next;
}

/** Marca que a conta já mandou uma mensagem. */
export async function noteFirstMessageSent(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return;
  const cur = await _read(em);
  if (cur.sent) return;
  await _write(em, { opens: cur.opens, sent: true });
}

async function _firstRunPending(email) {
  try {
    const raw = await AsyncStorage.getItem('chatyy_firstrun_v1:' + String(email || '').trim().toLowerCase());
    const v = raw ? JSON.parse(raw) : null;
    return v?.status === 'pending';
  } catch { return false; }
}

/** true quando o 1º uso real já passou para esta conta. */
export async function isPastFirstUse(email) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return false;
  if (await _firstRunPending(em)) return false;
  const cur = await _read(em);
  return !!cur.sent || (Number(cur.opens) || 0) >= FIRST_USE_OPENS;
}

/**
 * Escuta o outbox até a 1ª mensagem enviada com sucesso e então para.
 * Devolve a função de cancelamento (sempre chamar no cleanup).
 */
export function watchFirstMessageSent(email, onSent) {
  const em = String(email || '').trim().toLowerCase();
  if (!em) return () => {};
  let unsub = null;
  let done = false;
  try {
    const ob = require('../../services/messageOutbox');
    const sub = ob?.subscribe || ob?.default?.subscribe;
    if (typeof sub === 'function') {
      unsub = sub('*', (snap) => {
        const s = snap?.state;
        if (done || (s !== 'sent' && s !== 'delivered' && s !== 'read')) return;
        done = true;
        noteFirstMessageSent(em).then(() => { try { onSent?.(); } catch {} }, () => {});
        try { unsub?.(); } catch {}
        unsub = null;
      });
    }
  } catch {}
  return () => { done = true; try { unsub?.(); } catch {} unsub = null; };
}
