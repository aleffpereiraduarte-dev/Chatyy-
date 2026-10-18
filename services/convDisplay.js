// [2026-10-18 storage-names] Nome + avatar de uma conversa a partir do cache
// LOCAL, SÍNCRONO (1º frame), com a mesma regra da lista de conversas
// (components/chatlist/nativeAdapter.buildRow):
//   Mensagens salvas → "Mensagens Salvas";
//   direta → apelido salvo (chat_nickname) > nome da AGENDA (último sync de
//            contatos, opcional) > nome de perfil (display_name/name) > parte
//            local do e-mail formatada ("anacarla.pereiraramos" → "Ana Carla
//            Pereira Ramos");
//   grupo/canal → nome do grupo.
// Fontes síncronas: smartChatCache (memória) + espelho MMKV do chatCache.
// Async (completa o que faltar): SQLite/IndexedDB do chatCache + agenda.
// Nunca devolve "#id": desconhecido = '' (a tela decide shimmer / "Conversa").

function _api() { try { return require('./api'); } catch { return null; } }
function _nick(email) {
  try { return require('./nicknames').getNickname(email) || ''; } catch { return ''; }
}

function _me() {
  try { const a = _api(); return String((a && a.getActiveAccountEmail && a.getActiveAccountEmail()) || '').toLowerCase(); } catch { return ''; }
}

function _pretty(x) {
  const s = String(x || '').trim();
  if (!s) return '';
  try {
    const a = _api();
    if (a && typeof a.emailToDisplayName === 'function') return a.emailToDisplayName(s) || s;
  } catch {}
  return s;
}

function _isGroupish(c) {
  const ty = c && c.type;
  return ty === 'group' || ty === 'channel' || ty === 'broadcast' || ty === 'community';
}

/** Mapa id → conversa do cache local (síncrono). */
export function convIndexSync() {
  const map = new Map();
  const add = (list) => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (!c || c.id == null) continue;
      const k = String(c.id);
      if (!map.has(k)) map.set(k, c);
    }
  };
  try { add(require('./smartChatCache').getCachedConversationsSync()); } catch {}
  try { add(require('./chatCache').getCachedConversationsMmkvSync()); } catch {}
  return map;
}

/** Completa o índice com o cache persistente inteiro (SQLite/IndexedDB). */
export async function convIndexAsync(base) {
  const map = base instanceof Map ? new Map(base) : new Map();
  try {
    const list = (await require('./chatCache').getCachedConversations()) || [];
    for (const c of list) {
      if (!c || c.id == null) continue;
      const k = String(c.id);
      if (!map.has(k)) map.set(k, c);
    }
  } catch {}
  return map;
}

/** e-mail → nome salvo na agenda (cache do último sync; Map vazio sem cache). */
export async function agendaNamesAsync() {
  try { return (await require('./contactSync').getAgendaNamesByEmail()) || new Map(); } catch { return new Map(); }
}

function _peerEmail(c, me) {
  const server = c.other_email || c.contact_email || c.peer_email || '';
  if (server && String(server).toLowerCase() !== me) return String(server);
  const m = (Array.isArray(c.members) ? c.members : []).find((x) => {
    const e = typeof x === 'string' ? x : (x && x.email) || '';
    return e && String(e).toLowerCase() !== me;
  });
  return m ? String(typeof m === 'string' ? m : m.email) : '';
}

/**
 * { title, email, uri, members, isGroup } da conversa (title '' = desconhecido).
 * opts: { t, agenda: Map<email, nome> }
 */
export function convDisplay(c, opts = {}) {
  if (!c) return { title: '', email: null, uri: '', members: undefined, isGroup: false };
  const t = opts.t;
  const me = _me();
  const isGroup = _isGroupish(c);
  if (isGroup) {
    const nm = String(c.name || c.display_name || c.title || '').trim();
    const photo = c.avatar_url || c.avatar || '';
    const members = !photo
      ? (Array.isArray(c.members) ? c.members : []).filter((m) => m && typeof m === 'object' && (m.email || m.display_name || m.name)).slice(0, 4)
      : [];
    return { title: nm, email: null, uri: photo, members: members.length >= 2 ? members : undefined, isGroup: true };
  }
  const peer = _peerEmail(c, me);
  if (c.type === 'saved' || (peer && me && peer.toLowerCase() === me)) {
    const lbl = (t && t('chat.savedMessages')) || 'Mensagens Salvas';
    return { title: lbl && lbl !== 'chat.savedMessages' ? lbl : 'Mensagens Salvas', email: me || null, uri: '', members: undefined, isGroup: false };
  }
  const pk = peer.toLowerCase();
  let title = (pk && _nick(pk)) || '';
  if (!title && pk && opts.agenda && typeof opts.agenda.get === 'function') title = opts.agenda.get(pk) || '';
  if (!title) {
    const raw = String(c.display_name || c.name || c.other_name || c.peer_name || '').trim();
    title = _pretty(raw || peer);
  }
  return { title: String(title || '').trim(), email: peer || null, uri: '', members: undefined, isGroup: false };
}
