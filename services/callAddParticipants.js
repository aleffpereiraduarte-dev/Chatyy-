// services/callAddParticipants.js — [2026-10-13 add-to-call]
//
// "Adicionar à chamada" (ligação 1:1 → grupo): lista do seletor + convite +
// mensagens de erro traduzidas. Usado por components/AddToCallSheet.js
// (app/call.js e app/group-call.js). Os seletores NATIVOS (iOS
// CallParticipantPicker.swift / Android CallContacts.kt) falam com os MESMOS
// endpoints e usam os mesmos códigos de erro.
//
// Servidor (script /root/ligacao-adicionar-servidor.sh):
//   chat_call_add_candidates { query?, call_id?, limit? }
//     → { recent:[], contacts:[], results:[], total }
//       linha: { email, name, username, avatar, call_state:'in_call'|'ringing'|'', recent, in_contacts }
//       só conversas direct + agenda do usuário (nunca o diretório), sem contas de teste.
//   chat_call_add { call_id, conversation_id, emails[], video }
//     erro → data.code: not_allowed | blocked | not_in_call | parental | no_invitees | rate_limited
//     ok   → data.invited[{email,name,reachable}], data.skipped[{email,reason}]
// Servidor antigo (sem chat_call_add_candidates): cai no chat_contacts e filtra
// contas de teste aqui — a lista fica pior, mas nunca vazia por causa disso.

import * as api from './api';

const HIDDEN_LOCAL = /^(apitest|appletest|smoketest|testkid|reels|noreply|no-reply|donotreply|do-not-reply|postmaster|mailer-daemon|abuse|root|system|bot|qa|qa\d+|qa-?bot|qa-?robot|test\d*|teste\d*|demo\d*)$/i;

export function isHiddenAccount(email) {
  const e = String(email || '').toLowerCase();
  const at = e.indexOf('@');
  if (at <= 0) return true;
  return HIDDEN_LOCAL.test(e.slice(0, at));
}

// Remove acentos + minúsculas (busca local "Ána" == "ana").
export function normalizeForSearch(s) {
  try {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  } catch {
    return String(s || '').toLowerCase().trim();
  }
}

function _rowFromServer(r) {
  const email = String(r?.email || '').toLowerCase();
  return {
    email,
    name: String(r?.name || '') || email.split('@')[0],
    username: String(r?.username || ''),
    avatar: String(r?.avatar || ''),
    callState: String(r?.call_state || ''),
    recent: !!r?.recent,
    inContacts: !!r?.in_contacts,
  };
}

function _payload(r) {
  if (!r || typeof r !== 'object') return null;
  if (r.success === false) return null;
  const d = r.data;
  return d && typeof d === 'object' ? d : null;
}

// Retorna { ok, recent, contacts, results, legacy }.
export async function fetchAddCandidates({ query = '', callId = '', limit = 80 } = {}) {
  const q = String(query || '').slice(0, 64);
  let r = null;
  try {
    r = await api.apiCall('chat_call_add_candidates', { query: q, call_id: callId || '', limit }, 'GET');
  } catch { r = null; }
  const p = _payload(r);
  if (p && (Array.isArray(p.recent) || Array.isArray(p.results))) {
    const map = (a) => (Array.isArray(a) ? a.map(_rowFromServer).filter((x) => x.email && !isHiddenAccount(x.email)) : []);
    return { ok: true, recent: map(p.recent), contacts: map(p.contacts), results: map(p.results), legacy: false };
  }
  const status = Number(r?.__httpStatus || 0);
  const transport = !r || status === 0;
  // Servidor antigo: "Unknown chat action" (400) → chat_contacts filtrado.
  if (!transport) {
    try {
      const c = await api.chatContacts();
      const list = (typeof api.apiList === 'function' ? api.apiList(c, 'contacts') : (Array.isArray(c?.data) ? c.data : []))
        .filter((x) => x && x.email && !isHiddenAccount(x.email))
        .map((x) => _rowFromServer({ email: x.email, name: x.name }));
      const qn = normalizeForSearch(q.replace(/^@/, ''));
      const filtered = qn
        ? list.filter((x) => normalizeForSearch(x.name).includes(qn) || x.email.includes(qn))
        : list.sort((a, b) => normalizeForSearch(a.name).localeCompare(normalizeForSearch(b.name)));
      return qn
        ? { ok: true, recent: [], contacts: [], results: filtered, legacy: true }
        : { ok: true, recent: [], contacts: filtered, results: [], legacy: true };
    } catch {}
  }
  return { ok: false, recent: [], contacts: [], results: [], legacy: false, offline: transport };
}

// Convida (toca) as pessoas na chamada que já está rolando.
// Retorna { ok, code, invited:[{email,name,reachable}], skipped:[{email,reason}] }.
export async function addToCall({ callId, conversationId, emails, video }) {
  const list = (Array.isArray(emails) ? emails : [emails]).filter(Boolean).map((e) => String(e).toLowerCase()).slice(0, 16);
  if (!callId || list.length === 0) return { ok: false, code: 'no_invitees', invited: [], skipped: [] };
  let r = null;
  try {
    r = await api.chatCallAdd(callId, list, conversationId, !!video);
  } catch { r = null; }
  const status = Number(r?.__httpStatus || 0);
  if (!r || (r.success === false && status === 0)) return { ok: false, code: 'network', invited: [], skipped: [] };
  const d = (r && typeof r.data === 'object' && r.data) || {};
  if (r.success === false) {
    let code = String(d.code || '');
    if (!code) {
      const m = String(r.message || '').toLowerCase();
      if (status === 429 || /rate/.test(m)) code = 'rate_limited';
      else if (/blocked/.test(m)) code = 'blocked';
      else if (/no valid invitees/.test(m)) code = 'not_allowed'; // servidor antigo
      else if (/not a member/.test(m)) code = 'not_in_call';
      else if (/limit|full|cheia|lotad/.test(m)) code = 'limit';
      else code = 'generic';
    }
    return { ok: false, code, invited: [], skipped: Array.isArray(d.skipped) ? d.skipped : [] };
  }
  return {
    ok: true,
    code: '',
    invited: Array.isArray(d.invited) ? d.invited : list.map((email) => ({ email, reachable: true })),
    skipped: Array.isArray(d.skipped) ? d.skipped : [],
  };
}

// Texto claro (i18n) p/ um código de erro. `name` = nome de exibição (ou vários "A, B").
export function addToCallErrorText(t, code, name) {
  const tr = (k, fb, vars) => {
    let s = '';
    try { s = typeof t === 'function' ? t(k, vars) : ''; } catch { s = ''; }
    if (!s || s === k) s = fb;
    if (vars) Object.keys(vars).forEach((v) => { s = String(s).split(`{${v}}`).join(String(vars[v])); });
    return s;
  };
  const who = name || '';
  switch (code) {
    case 'not_allowed': return tr('callAdd.errNotAllowed', 'Você só pode adicionar pessoas com quem já conversa ou que estão na sua agenda.');
    case 'blocked': return tr('callAdd.errBlocked', 'Não é possível chamar {name}.', { name: who });
    case 'not_in_call': return tr('callAdd.errNotInCall', 'Esta chamada já terminou.');
    case 'parental': return tr('callAdd.errParental', 'O controle parental não permite adicionar {name}.', { name: who });
    case 'rate_limited': return tr('callAdd.errRateLimited', 'Muitas tentativas. Aguarde um instante e tente de novo.');
    case 'offline': return tr('callAdd.errOffline', '{name} não pode receber chamadas agora.', { name: who });
    case 'limit': return tr('callAdd.errLimit', 'A chamada atingiu o limite de participantes.');
    case 'network': return tr('callAdd.errNetwork', 'Sem conexão. Verifique sua internet e tente de novo.');
    default: return tr('callAdd.errGeneric', 'Não foi possível chamar {name}. Tente de novo.', { name: who });
  }
}
