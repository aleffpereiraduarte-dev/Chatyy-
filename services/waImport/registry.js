// [2026-10-10 wa-import] Quais conversas são importações do WhatsApp (por conta).
// Fonte: wa_import_list. Cache em memória + AsyncStorage com a conta na chave
// (nunca vaza entre contas). Usado pela conversa (só leitura + selo) e pela tela
// de importação (continuar / abrir / apagar).
import { getSavedEmail, getActiveAccountEmail } from '../api';
import { waImportList } from './api';

const TTL_MS = 10 * 60 * 1000;
let _mem = { email: '', ids: new Set(), items: [], at: 0 };
let _inflight = null;

function _email() { try { return (getActiveAccountEmail() || getSavedEmail() || '').toLowerCase(); } catch { return ''; } }
function _key(email) { return `waimp:list:v1:${email}`; }

function _storage() {
  try { return require('@react-native-async-storage/async-storage').default; } catch { return null; }
}

function _apply(email, items, at) {
  _mem = { email, items: Array.isArray(items) ? items : [], ids: new Set((items || []).map((i) => Number(i.conversation_id))), at: at || Date.now() };
}

async function _hydrate(email) {
  if (_mem.email === email && _mem.at) return;
  const st = _storage();
  if (!st) return;
  try {
    const raw = await st.getItem(_key(email));
    if (raw) {
      const j = JSON.parse(raw);
      if (j && Array.isArray(j.items) && _mem.email !== email) _apply(email, j.items, j.at || 1);
    }
  } catch {}
}

export async function refreshImports(force = false) {
  const email = _email();
  if (!email) return [];
  await _hydrate(email);
  if (!force && _mem.email === email && Date.now() - _mem.at < TTL_MS) return _mem.items;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const r = await waImportList();
      const items = r?.success ? (r.data?.items || []) : null;
      if (items && _email() === email) {
        _apply(email, items, Date.now());
        try { await _storage()?.setItem(_key(email), JSON.stringify({ items, at: Date.now() })); } catch {}
      }
    } catch {}
    return _mem.email === email ? _mem.items : [];
  })();
  try { return await _inflight; } finally { _inflight = null; }
}

export function isImportedConversationSync(convId) {
  const email = _email();
  return !!(email && _mem.email === email && _mem.ids.has(Number(convId)));
}

export async function isImportedConversation(convId) {
  if (!convId) return false;
  const email = _email();
  if (!email) return false;
  await _hydrate(email);
  if (_mem.email === email && _mem.ids.has(Number(convId))) return true;
  // Só consulta o servidor se o cache estiver velho (evita 1 request por conversa aberta).
  if (_mem.email === email && Date.now() - _mem.at < TTL_MS) return false;
  const items = await refreshImports(true);
  return (items || []).some((i) => Number(i.conversation_id) === Number(convId));
}

export function rememberImport(item) {
  const email = _email();
  if (!email || !item) return;
  const items = (_mem.email === email ? _mem.items : []).filter((i) => Number(i.id) !== Number(item.id));
  items.unshift(item);
  _apply(email, items, Date.now());
  try { _storage()?.setItem(_key(email), JSON.stringify({ items, at: Date.now() })); } catch {}
}

export function forgetImport(importId) {
  const email = _email();
  if (!email || _mem.email !== email) return;
  const items = _mem.items.filter((i) => Number(i.id) !== Number(importId));
  _apply(email, items, Date.now());
  try { _storage()?.setItem(_key(email), JSON.stringify({ items, at: Date.now() })); } catch {}
}
