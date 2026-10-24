// [email-global 2026-10-24] Aviso ÚNICO "Seu e-mail ficou global" (@chatyy.app).
//
// Quem já tinha fulano@chatyy.com.br ganhou o alias fulano@chatyy.app (mesma
// caixa). O servidor diz quando o alias está ATIVO para a conta no get_profile:
//   data.email_global = { active: true, old_email: 'x@chatyy.com.br', new_email: 'x@chatyy.app' }
// Este serviço decide se o aviso sai (1× por conta neste aparelho) e entrega o
// evento ao components/EmailGlobalNoticeHost (folha do sistema, montada no _layout).
//
// Regras:
//  - flag globalThis.__chatyy_email_global_notice === true (padrão DESLIGADO);
//  - conta ativa precisa ser @chatyy.com.br e igual ao old_email do servidor;
//    cadastro novo (@chatyy.app) nunca vê (não existe endereço antigo);
//  - new_email precisa ser @chatyy.app com o mesmo usuário;
//  - visto = gravado no AsyncStorage NO MOMENTO em que a folha abre (nunca repete).
import AsyncStorage from '@react-native-async-storage/async-storage';

const SEEN_PREFIX = 'email_global_notice_seen:v1:';
const OLD_DOMAIN = '@chatyy.com.br';
const NEW_DOMAIN = '@chatyy.app';

const _subs = new Set();
let _pending = null;
const _inflight = new Set();

export function emailGlobalNoticeEnabled() {
  try { return globalThis.__chatyy_email_global_notice === true; } catch { return false; }
}

// Valida o campo do servidor. Retorna { old, next } ou null.
export function parseEmailGlobal(accountEmail, data) {
  try {
    const eg = data && typeof data === 'object' ? data.email_global : null;
    if (!eg || typeof eg !== 'object' || eg.active !== true) return null;
    const acct = String(accountEmail || '').trim().toLowerCase();
    const old = String(eg.old_email || '').trim().toLowerCase();
    const next = String(eg.new_email || '').trim().toLowerCase();
    if (!acct.endsWith(OLD_DOMAIN) || old !== acct) return null;
    if (!next.endsWith(NEW_DOMAIN)) return null;
    if (next.slice(0, -NEW_DOMAIN.length) !== old.slice(0, -OLD_DOMAIN.length)) return null;
    return { old, next };
  } catch { return null; }
}

function _emit(ev) {
  if (!_subs.size) { _pending = ev; return; }
  _subs.forEach((fn) => { try { fn(ev); } catch {} });
}

// Chamado com a resposta do get_profile (context/AuthContext).
export async function maybeQueueEmailGlobalNotice(accountEmail, data) {
  if (!emailGlobalNoticeEnabled()) return false;
  const ev = parseEmailGlobal(accountEmail, data);
  if (!ev || _inflight.has(ev.old)) return false;
  _inflight.add(ev.old);
  try {
    let seen = null;
    try { seen = await AsyncStorage.getItem(SEEN_PREFIX + ev.old); } catch {}
    if (seen) return false;
    _emit(ev);
    return true;
  } finally {
    _inflight.delete(ev.old);
  }
}

export async function markEmailGlobalNoticeSeen(oldEmail) {
  const k = String(oldEmail || '').trim().toLowerCase();
  if (!k) return;
  try { await AsyncStorage.setItem(SEEN_PREFIX + k, String(Date.now())); } catch {}
}

export async function wasEmailGlobalNoticeSeen(oldEmail) {
  try { return !!(await AsyncStorage.getItem(SEEN_PREFIX + String(oldEmail || '').trim().toLowerCase())); } catch { return false; }
}

export function subscribeEmailGlobalNotice(fn) {
  _subs.add(fn);
  if (_pending) { const p = _pending; _pending = null; try { fn(p); } catch {} }
  return () => { _subs.delete(fn); };
}
