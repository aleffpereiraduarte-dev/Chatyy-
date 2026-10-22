// [salvas-fav 2026-10-22] Cache local (MMKV/KV) + SWR p/ "Favoritas" e "Mensagens Salvas".
//
// Antes: a tela Favoritas esperava chat_starred_messages E chat_conversations (lista
// inteira, p90 1,4 s no US / até 25 s no BR2 no incidente 21/10) antes de pintar
// qualquer linha; "Mensagens Salvas" mostrava um spinner até chat_saved_conv voltar
// do US (edge encaminhava: 140 ms–1,2 s) e só então abria a conversa.
// Agora: pinta do cache no 1º frame e revalida em 2º plano (igual à lista de conversas).
//
// Chaves começam com `chat_` → chatCache.resetForAccountSwitch() apaga na troca de
// conta; além disso cada valor carrega o dono (`o`) e só é lido p/ o mesmo e-mail.
// Kill: globalThis.__chatyy_saved_star_cache = false (volta a ir só pela rede).
import { getJSON, setJSON } from './mmkv';

const K_STAR = 'chat_starred_list_v1';
const K_SAVED = 'chat_saved_conv_v1';
const MAX_ITEMS = 300;
const MAX_TEXT = 2000;

function _on() {
  try { return globalThis.__chatyy_saved_star_cache !== false; } catch { return true; }
}
function _owner(email) { return String(email || '').trim().toLowerCase(); }
function _locked() {
  try { return !!require('./chatCache').isCacheScopeLocked?.(); } catch { return false; }
}

// ── Favoritas ────────────────────────────────────────────────────────────────
export function getCachedStarred(email) {
  const o = _owner(email);
  if (!o || !_on() || _locked()) return null;
  try {
    const v = getJSON(K_STAR);
    if (!v || v.o !== o || !Array.isArray(v.items)) return null;
    return v.items;
  } catch { return null; }
}

export function setCachedStarred(email, items) {
  const o = _owner(email);
  if (!o || !_on() || !Array.isArray(items)) return;
  try {
    const slim = items.slice(0, MAX_ITEMS).map((m) => {
      if (!m || typeof m !== 'object') return m;
      if (typeof m.content === 'string' && m.content.length > MAX_TEXT) return { ...m, content: m.content.slice(0, MAX_TEXT) };
      return m;
    });
    setJSON(K_STAR, { o, t: Date.now(), items: slim });
  } catch {}
}

// Desfavoritou em qualquer tela → some do cache já (sem esperar a revalidação).
export function removeCachedStarred(messageId) {
  if (messageId == null) return;
  try {
    const v = getJSON(K_STAR);
    if (!v || !Array.isArray(v.items)) return;
    const id = String(messageId);
    const next = v.items.filter((m) => String(m?.id) !== id);
    if (next.length !== v.items.length) setJSON(K_STAR, { ...v, items: next });
  } catch {}
}

// Normaliza a resposta de chat_starred_messages ({items}|{messages}|array).
export function starredListFrom(r) {
  if (!r || !r.success || !r.data) return null;
  const list = Array.isArray(r.data) ? r.data : (r.data.items || r.data.messages || null);
  return Array.isArray(list) ? list : null;
}

// SWR: devolve o cache na hora (sync) e dispara a revalidação.
// onFresh(list) só é chamado quando a rede responde com sucesso.
let _inflight = null;
export function fetchStarred(email, onFresh) {
  const api = require('./api');
  if (!_inflight) {
    _inflight = Promise.resolve()
      .then(() => api.chatStarredMessages())
      .then((r) => {
        const list = starredListFrom(r);
        if (list) setCachedStarred(email, list);
        return list;
      })
      .catch(() => null)
      .finally(() => { _inflight = null; });
  }
  return _inflight.then((list) => {
    if (list && typeof onFresh === 'function') { try { onFresh(list); } catch {} }
    return list;
  });
}

// ── Mensagens Salvas (id da conversa consigo mesmo) ─────────────────────────
// O id NÃO muda depois de criado → cache praticamente eterno; revalida 1×/abertura.
export function getCachedSavedConvId(email) {
  const o = _owner(email);
  if (!o || !_on() || _locked()) return null;
  try {
    const v = getJSON(K_SAVED);
    if (!v || v.o !== o) return null;
    const id = Number(v.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch { return null; }
}

export function setCachedSavedConvId(email, id) {
  const o = _owner(email);
  const n = Number(id);
  if (!o || !_on() || !Number.isFinite(n) || n <= 0) return;
  try { setJSON(K_SAVED, { o, id: n, t: Date.now() }); } catch {}
}

// Resolve o id (rede) e grava no cache. Dedup de chamadas simultâneas.
let _savedInflight = null;
export function resolveSavedConv(email) {
  if (_savedInflight) return _savedInflight;
  const api = require('./api');
  _savedInflight = Promise.resolve()
    .then(() => api.chatSavedConv())
    .then((r) => {
      const id = r?.success ? Number(r.data?.conversation_id) : 0;
      if (id > 0) setCachedSavedConvId(email, id);
      return r;
    })
    .finally(() => { _savedInflight = null; });
  return _savedInflight;
}

// Aquecimento barato (ex.: ao abrir a tela Salvas|Favoritas): só busca se não houver cache.
export function prewarmSavedConv(email) {
  if (!_owner(email) || getCachedSavedConvId(email)) return;
  resolveSavedConv(email).catch(() => {});
}

// Abre "Mensagens Salvas" direto na conversa quando o id é conhecido (linha da lista
// ou cache), pulando a tela-ponte /saved-messages (push + spinner + replace).
// Devolve true se abriu; false = chamador segue o caminho antigo ('/saved-messages').
// knownId (linha tocada da lista) NÃO é gravado no cache: conta antiga pode ter 2 auto-conversas
// (type saved + direct consigo) e o cache segue só o que o servidor (chat_saved_conv) devolve.
export function openSavedFast({ email, knownId, name, router } = {}) {
  try {
    if (!_on()) return false;
    const kid = Number(knownId);
    const id = (Number.isFinite(kid) && kid > 0) ? kid : getCachedSavedConvId(email);
    if (!id) return false;
    const nm = encodeURIComponent(name || 'Mensagens Salvas');
    require('./openConversation').openConversation(`/chat-conversation?id=${id}&name=${nm}&type=saved&saved=1`, router ? { router } : {});
    if (!(kid > 0)) resolveSavedConv(email).catch(() => {});
    return true;
  } catch { return false; }
}
