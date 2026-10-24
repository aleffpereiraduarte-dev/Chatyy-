// components/chat/contactShare.js — [2026-10-17 share-contact] "Enviar contato"
// estilo WhatsApp: formato da mensagem, leitura retrocompatível, rótulos e as
// ações do cartão (Mensagem / Ligar / Adicionar / Convidar) num lugar só —
// usados pelo seletor (ShareContactPicker), pelo cartão JS e nativo
// (chat-conversation / nativeRowCards), pela folha de detalhes
// (ContactCardSheet) e pela prévia da lista de conversas.
//
// Mensagem type 'contact', content = JSON:
//   { v: 2, name, phone, email, phones: ['+55…'], chatyy: true|undefined,
//     avatar?: 'https://…', contacts?: [ {name, phone, phones, email, chatyy, avatar}, … ] }
// Campos de topo = 1º contato (cliente antigo lê {name, phone, email} e mostra
// o 1º); `contacts` só quando há mais de um (até MAX_SHARE_CONTACTS).
// Formatos antigos aceitos: {name, phone, email}, vCard (BEGIN:VCARD), objeto.
import { Platform, Linking, Share } from 'react-native';

export const MAX_SHARE_CONTACTS = 5;

function _tr(t, k, fb) {
  try { const v = typeof t === 'function' ? t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; }
}
function _str(v) { return typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : ''); }
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Número → E.164 (+dígitos) usando o DDI do aparelho p/ números nacionais. */
export function toE164Smart(raw) {
  const s = _str(raw);
  if (!s) return '';
  const d = s.replace(/\D+/g, '');
  if (!d) return '';
  let out = '';
  if (s.startsWith('+')) out = '+' + d;
  else if (s.startsWith('00') && d.length > 6) out = '+' + d.replace(/^00/, '');
  else {
    let hd = '55';
    try { hd = require('../../services/contactSync').getHomeDialDigits() || '55'; } catch {}
    const nt = d.replace(/^0+/, '');
    if (hd === '55' && d[0] === '0' && (d.length === 13 || d.length === 14)) out = '+55' + d.slice(3); // 0 + operadora + DDD + número
    else if (nt.startsWith(hd) && nt.length >= hd.length + 10) out = '+' + nt;
    else out = '+' + hd + nt;
  }
  return /^\+\d{7,15}$/.test(out) ? out : s;
}

function _parseVcard(tr) {
  const card = { name: '', phone: '', email: '', phones: [] };
  for (const ln of tr.split(/\r?\n/)) {
    if (/^FN[:;]/i.test(ln)) card.name = ln.replace(/^FN[^:]*:/i, '').trim();
    else if (!card.name && /^N[:;]/i.test(ln)) card.name = ln.replace(/^N[^:]*:/i, '').split(';').filter(Boolean).reverse().join(' ').trim();
    else if (/^TEL/i.test(ln)) { const p = ln.replace(/^TEL[^:]*:/i, '').trim(); if (p) { card.phones.push(p); if (!card.phone) card.phone = p; } }
    else if (!card.email && /^EMAIL/i.test(ln)) card.email = ln.replace(/^EMAIL[^:]*:/i, '').trim();
  }
  return card;
}

function _one(o) {
  if (!o || typeof o !== 'object') return null;
  const phones = [];
  const seen = new Set();
  const addP = (p) => { const x = _str(p); if (!x) return; const k = x.replace(/[^\d+]/g, ''); if (!k || seen.has(k)) return; seen.add(k); phones.push(x); };
  addP(o.phone);
  if (Array.isArray(o.phones)) o.phones.forEach((p) => addP(p && typeof p === 'object' ? (p.number || p.phone) : p));
  const email = _str(o.email || o.chatyy_email);
  const name = _str(o.name) || phones[0] || email;
  if (!name && !phones.length && !email) return null;
  const avatar = /^https:\/\//i.test(_str(o.avatar)) ? _str(o.avatar) : '';
  return { name, phone: phones[0] || '', phones, email: EMAIL_RE.test(email) ? email : '', chatyy: !!o.chatyy && EMAIL_RE.test(email), avatar };
}

/**
 * Mensagem (ou content/objeto) → { list: [contato…], first, count }.
 * Nunca lança; list vazia = cartão inválido.
 */
export function parseContactPayload(src, fallbackName) {
  let raw = src;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw.content !== undefined || raw.contact !== undefined) && raw.name === undefined) {
    raw = (raw.contact && typeof raw.contact === 'object') ? raw.contact : raw.content;
  }
  let obj = null;
  if (raw && typeof raw === 'object') obj = raw;
  else if (typeof raw === 'string') {
    const tr = raw.trim();
    if (/^BEGIN:VCARD/i.test(tr)) { try { obj = _parseVcard(tr); } catch { obj = null; } }
    else if (tr.startsWith('{')) { try { obj = JSON.parse(tr); } catch { obj = null; } }
  }
  const list = [];
  if (obj && typeof obj === 'object') {
    if (Array.isArray(obj.contacts) && obj.contacts.length) {
      for (const c of obj.contacts.slice(0, 20)) { const x = _one(c); if (x) list.push(x); }
    }
    if (!list.length) { const x = _one(obj); if (x) list.push(x); }
  }
  if (!list.length && fallbackName) list.push({ name: String(fallbackName), phone: '', phones: [], email: '', chatyy: false, avatar: '' });
  return { list, first: list[0] || null, count: list.length };
}

/** Seleção do seletor → content (string JSON) da mensagem. */
export function buildContactPayload(cards) {
  const list = (Array.isArray(cards) ? cards : []).map(_one).filter(Boolean).slice(0, MAX_SHARE_CONTACTS);
  if (!list.length) return '';
  const slim = (c) => {
    const o = { name: c.name, phone: c.phone || '', email: c.email || '' };
    if (c.phones && c.phones.length) o.phones = c.phones.slice(0, 6);
    if (c.chatyy && c.email) o.chatyy = true;
    if (c.avatar) o.avatar = c.avatar;
    return o;
  };
  const top = { v: 2, ...slim(list[0]) };
  if (list.length > 1) top.contacts = list.map(slim);
  return JSON.stringify(top);
}

/** "Sara" · "Sara e mais 2" */
export function contactTitle(parsed, t) {
  if (!parsed || !parsed.first) return _tr(t, 'chatConv.contact', 'Contato');
  if (parsed.count <= 1) return parsed.first.name;
  return _tr(t, 'shareContact.andMore', '{name} e mais {n}').split('{name}').join(parsed.first.name).split('{n}').join(String(parsed.count - 1));
}

/** Prévia da lista / notificação: "Contato: Sara" · "Contatos: Sara e mais 2". */
export function contactPreviewLabel(src, t) {
  const p = parseContactPayload(src);
  if (!p.first) return _tr(t, 'chat.contact', 'Contato');
  if (p.count > 1) return _tr(t, 'shareContact.previewMany', 'Contatos: {name}').split('{name}').join(contactTitle(p, t));
  return _tr(t, 'shareContact.previewOne', 'Contato: {name}').split('{name}').join(p.first.name);
}

// ─── "tem Chatyy?" (cache de módulo, compartilhado pelos cartões) ──────────
const _chk = new Map(); // key → { loading, has, email, subs:Set }
function _key(c) { return String((c && c.email) || '').toLowerCase() + '|' + String((c && c.phone) || ''); }

/** Estado síncrono (sem rede); cartão com `chatyy:true` + e-mail = sim na hora. */
export function chatyyStateSync(c) {
  if (!c) return { loading: false, has: false, email: '' };
  // [privacidade] não confia no 'chatyy:true' do remetente: quem desligou 'ser encontrado' não aparece; sempre checa no servidor.
  const h = _chk.get(_key(c));
  if (h && !h.loading) return { loading: false, has: h.has, email: h.email || c.email };
  return null;
}

/** Resolve (com cache) se o contato tem Chatyy → { has, email }. */
export function resolveChatyy(c) {
  const sync = chatyyStateSync(c);
  if (sync) return Promise.resolve(sync);
  if (!c || (!c.email && !c.phone)) return Promise.resolve({ loading: false, has: false, email: '' });
  const k = _key(c);
  let ent = _chk.get(k);
  if (ent && ent.p) return ent.p;
  ent = { loading: true, has: false, email: c.email || '' };
  ent.p = (async () => {
    let has = false; let email = c.email || '';
    try {
      const r = await require('../../services/api').chatCheckChatyy({ email: c.email || '', phone: c.phone || '' });
      has = !!(r && r.data && r.data.has_chatyy);
      if (has && r.data.email) email = r.data.email;
    } catch {}
    ent.loading = false; ent.has = has; ent.email = email;
    if (_chk.size > 400) { const k0 = _chk.keys().next().value; if (k0 !== k) _chk.delete(k0); }
    return { loading: false, has, email };
  })();
  _chk.set(k, ent);
  return ent.p;
}

// ─── ações ──────────────────────────────────────────────────────────────────
function _alert(a, b) {
  if (Platform.OS === 'web') { try { window.alert(b || a); } catch {} return; }
  try { require('react-native').Alert.alert(a, b); } catch {}
}

// ─── [2026-10-21 contato-msg] estado por cartão (carregando / salvo) ─────────
// "Mensagem" abre DIRETO a conversa 1:1 (get-or-create via openDirectConversation,
// o mesmo caminho do "Fala oi"/seguir) — antes ia p/ /chat-new, que ignorava
// ?email= e só mostrava a tela "Nova conversa" vazia. Cartão JS e nativo leem o
// mesmo estado daqui (subscribeContactState → re-render / bump do nativo).
const _subs = new Set();
const _busy = new Map(); // key → 'msg' | 'call'
const _book = new Map(); // key → { saved, id }
function _emit() { _subs.forEach((fn) => { try { fn(); } catch {} }); }
export function subscribeContactState(fn) { _subs.add(fn); return () => { _subs.delete(fn); }; }
export function contactBusy(c) { return _busy.get(_key(c)) || ''; }
function _setBusy(c, v) { const k = _key(c); if (v) _busy.set(k, v); else _busy.delete(k); _emit(); }

function _myEmail(opts) {
  const m = String((opts && opts.myEmail) || '').trim().toLowerCase();
  if (m) return m;
  try { return String(require('../../services/api').getSavedEmail() || '').trim().toLowerCase(); } catch { return ''; }
}
function _toastErr(t, msg) {
  try { require('../ui/Toast').showErrorToast({ message: msg || _tr(t, 'shareContact.openChatError', 'Não foi possível abrir a conversa. Tente de novo.') }); return; } catch {}
  _alert(_tr(t, 'common.error', 'Erro'), msg || '');
}

/**
 * "Mensagem": resolve a pessoa (e-mail do cartão ou busca por telefone) e abre
 * a conversa direta, criando se não existir. Contato = você → Mensagens Salvas.
 * Sem Chatyy → convite. Feedback: contactBusy(c) === 'msg' enquanto resolve.
 */
export async function openChatWith(c, router, resolvedEmail, opts = {}) {
  if (!c) return false;
  if (_busy.get(_key(c))) return false; // toque duplo
  const t = opts.t;
  _setBusy(c, 'msg');
  try {
    let em = String(resolvedEmail || '').trim().toLowerCase();
    if (!em) {
      if (!c.email && !c.phone) { _toastErr(t, _tr(t, 'chatConv.contactNoTarget', 'Sem telefone ou email para iniciar conversa')); return false; }
      const r = await resolveChatyy(c);
      if (r && r.has) em = String(r.email || c.email || '').trim().toLowerCase();
      else { inviteContact(c, t); return false; }
    }
    if (em === _myEmail(opts)) {
      try { (router || require('expo-router').router).push('/saved-messages'); } catch {}
      return true;
    }
    const res = await require('../../services/openConversation').openDirectConversation(em, c.name ? { name: c.name } : {});
    return res !== 'noop';
  } catch {
    _toastErr(t);
    return false;
  } finally {
    _setBusy(c, '');
  }
}

/**
 * "Ligar": quem tem Chatyy → ligação de voz Chatyy (mesmo voipNative.startOutgoingCall
 * do botão do cabeçalho) com confirmação; sem Chatyy + número → telefone do aparelho.
 */
export function callContact(c, router, t, resolvedEmail, opts = {}) {
  if (!c) return;
  let pstn = false;
  try { pstn = require('../../constants/featureFlags').isPstnEnabled() === true; } catch {}
  const em = String(resolvedEmail || '').trim().toLowerCase();
  const name = c.name || c.phone || em;
  const title = _tr(t, 'shareContact.callConfirmTitle', 'Ligar para {name}?').split('{name}').join(name);
  const confirm = (body, onYes) => {
    const buttons = [
      { text: _tr(t, 'common.cancel', 'Cancelar'), style: 'cancel' },
      { text: _tr(t, 'chatConv.callContact', 'Ligar'), onPress: onYes },
    ];
    try { require('../../services/alerts').safeAlert(title, body, buttons); } catch { onYes(); }
  };
  if (em && !pstn) {
    if (em === _myEmail(opts)) return;
    confirm(_tr(t, 'shareContact.callConfirmChatyy', 'Ligação de voz pelo Chatyy.'), () => {
      (async () => {
        let ok = false;
        try { ok = await require('../../services/chatyyOnlyCalls').startChatyyCall({ email: em, name: c.name, router }); } catch {}
        if (!ok) _toastErr(t, _tr(t, 'shareContact.callError', 'Não foi possível iniciar a ligação.'));
      })();
    });
    return;
  }
  if (c.phone && pstn) {
    const num = c.phone.replace(/[^+\d]/g, '');
    confirm(_tr(t, 'shareContact.callConfirmPhone', 'A ligação será feita pelo telefone do aparelho.'), () => { Linking.openURL(`tel:${num}`).catch(() => {}); });
    return;
  }
  try { require('../../services/chatyyOnlyCalls').callPhoneViaChatyy({ phone: c.phone, email: c.email, name: c.name, router, t }); } catch {}
}

export async function inviteContact(c, t) {
  // [2026-10-21 contato-msg] link pessoal (chatyy.com.br/baixar?ref=<código>) do inviteContact.
  let msg = '';
  try { const inv = require('../../services/inviteContact'); try { await inv.prefetchInviteRef(); } catch {} msg = inv.buildInviteMessage(t, c && c.name); } catch {}
  if (!msg) msg = `${c && c.name ? c.name + ', ' : ''}${_tr(t, 'chat.inviteShareMessage', 'instala o Chatyy: https://chatyy.app')}`;
  if (c && c.phone && Platform.OS !== 'web') {
    const clean = c.phone.replace(/[^+\d]/g, '');
    const sep = Platform.OS === 'ios' ? '&' : '?';
    try { await Linking.openURL(`sms:${clean}${sep}body=${encodeURIComponent(msg)}`); return; } catch {}
  }
  try { await Share.share({ message: msg, title: 'Chatyy' }); } catch {}
}

// ─── "já está na agenda?" (só consulta se a permissão JÁ foi dada; nunca pede) ──
function _digits(s) { return String(s || '').replace(/\D+/g, ''); }
function _sameNum(a, b) { const x = _digits(a); const y = _digits(b); if (x.length < 7 || y.length < 7) return false; return x.slice(-8) === y.slice(-8); }
async function _findInPhonebook(c) {
  if (Platform.OS === 'web' || !c) return null;
  const Contacts = require('expo-contacts');
  const perm = await Contacts.getPermissionsAsync();
  if (!perm || perm.status !== 'granted') return null;
  const phones = (c.phones && c.phones.length ? c.phones : (c.phone ? [c.phone] : []));
  const em = String(c.email || '').toLowerCase();
  const nm = String(c.name || '').trim();
  if (!nm || (!phones.length && !em)) return null;
  const { data } = await Contacts.getContactsAsync({ name: nm, fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails], pageSize: 25 });
  for (const x of (data || [])) {
    const hitE = em && (x.emails || []).some((e) => String((e && e.email) || '').toLowerCase() === em);
    const hitP = phones.length && (x.phoneNumbers || []).some((p) => phones.some((q) => _sameNum(p && (p.number || p.digits), q)));
    if (hitE || hitP) return { saved: true, id: x.id || x.lookupKey || '' };
  }
  return { saved: false, id: '' };
}
/** Estado síncrono (null = ainda não sabe). */
export function phonebookStateSync(c) { return _book.get(_key(c)) || null; }
/** Checa a agenda em 2º plano (cache); avisa os cartões quando muda. */
export function checkPhonebook(c, force) {
  const k = _key(c);
  const cur = _book.get(k);
  if (cur && !force) return Promise.resolve(cur);
  if (!cur) _book.set(k, { saved: false, id: '', pending: true });
  return (async () => {
    let r = null;
    try { r = await _findInPhonebook(c); } catch { r = null; }
    const next = r || { saved: false, id: '' };
    const prev = _book.get(k);
    _book.set(k, next);
    if (_book.size > 400) { const k0 = _book.keys().next().value; if (k0 !== k) _book.delete(k0); }
    if (!prev || prev.saved !== next.saved) _emit();
    return next;
  })();
}

/** "Adicionar": já salvo → abre o contato na agenda; senão formulário do sistema. */
export async function addOrOpenContact(c, t) {
  if (!c) return;
  const st = phonebookStateSync(c);
  if (st && st.saved && st.id && Platform.OS !== 'web') {
    try { await require('expo-contacts').presentFormAsync(st.id); return; } catch {}
  }
  await saveToPhonebook(c, t);
  if (Platform.OS !== 'web') { try { await checkPhonebook(c, true); } catch {} }
}

/** Formulário do sistema já preenchido (todos os números); fallback addContactAsync / .vcf no web. */
export async function saveToPhonebook(c, t) {
  if (!c) return;
  const phones = (c.phones && c.phones.length ? c.phones : (c.phone ? [c.phone] : []));
  if (Platform.OS === 'web') {
    try {
      const esc = (s) => String(s || '').replace(/[\r\n]+/g, ' ');
      const vcf = `BEGIN:VCARD\nVERSION:3.0\nFN:${esc(c.name)}\n${phones.map((p) => `TEL;TYPE=CELL:${esc(p)}\n`).join('')}${c.email ? `EMAIL:${esc(c.email)}\n` : ''}END:VCARD`;
      const blob = new Blob([vcf], { type: 'text/vcard' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${(c.name || 'contato').replace(/[\\/:*?"<>|]+/g, '')}.vcf`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch {} }, 100);
    } catch {}
    return;
  }
  // [2026-10-17 p2] negado de vez → aviso com "Abrir ajustes" (padrão de app/contacts.js)
  const deny = (perm) => {
    try { require('../../services/deviceContactLookup').alertContactsDenied(t, perm); return; } catch {}
    _alert(_tr(t, 'chatConv.permission', 'Permissão'), _tr(t, 'chatConv.contactsPermission', 'Permita acesso aos contatos.'));
  };
  try {
    const Contacts = require('expo-contacts');
    const parts = String(c.name || '').trim().split(/\s+/);
    const form = {
      [Contacts.Fields.FirstName]: parts.length > 1 ? parts.slice(0, -1).join(' ') : (c.name || ''),
      ...(parts.length > 1 ? { [Contacts.Fields.LastName]: parts[parts.length - 1] } : {}),
      ...(phones.length ? { [Contacts.Fields.PhoneNumbers]: phones.map((p, i) => ({ label: i === 0 ? 'mobile' : 'other', number: p })) } : {}),
      ...(c.email ? { [Contacts.Fields.Emails]: [{ label: 'home', email: c.email }] } : {}),
    };
    if (typeof Contacts.presentFormAsync === 'function') {
      let ok = false;
      try {
        if (Platform.OS !== 'ios') {
          const perm = await Contacts.requestPermissionsAsync();
          if (perm?.status !== 'granted') { deny(perm); return; }
        }
        await Contacts.presentFormAsync(null, form, { isNew: true });
        ok = true;
      } catch {}
      if (ok) return;
    }
    const _perm = await Contacts.requestPermissionsAsync();
    if (_perm?.status !== 'granted') { deny(_perm); return; }
    await Contacts.addContactAsync(form);
    _alert(_tr(t, 'common.success', 'Sucesso'), _tr(t, 'chatConv.contactSaved', 'Contato salvo'));
  } catch {
    _alert(_tr(t, 'common.error', 'Erro'), _tr(t, 'chatConv.contactSaveError', 'Não foi possível salvar o contato'));
  }
}

/** Número bonito (+55 (11) 99999-8888); outros países ficam como vieram. */
export function prettyPhone(p) {
  const raw = _str(p);
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+55') || (d.length === 13 && d.startsWith('55'))) {
    const r = d.slice(2);
    if (r.length === 11) return `+55 (${r.slice(0, 2)}) ${r.slice(2, 7)}-${r.slice(7)}`;
    if (r.length === 10) return `+55 (${r.slice(0, 2)}) ${r.slice(2, 6)}-${r.slice(6)}`;
  }
  return raw;
}
