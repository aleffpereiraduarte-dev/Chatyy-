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

export function openChatWith(c, router, resolvedEmail) {
  const em = resolvedEmail || (c && c.email) || '';
  try {
    if (em) router.push(`/chat-new?email=${encodeURIComponent(em)}`);
    else if (c && c.phone) router.push(`/chat-new?phone=${encodeURIComponent(c.phone)}`);
  } catch {}
}

export function callContact(c, router, t, resolvedEmail) {
  if (!c) return;
  let pstn = false;
  try { pstn = require('../../constants/featureFlags').isPstnEnabled() === true; } catch {}
  if (pstn && c.phone) { Linking.openURL(`tel:${c.phone.replace(/[^+\d]/g, '')}`).catch(() => {}); return; }
  try {
    const em = resolvedEmail || '';
    if (em) require('../../services/chatyyOnlyCalls').startChatyyCall({ email: em, name: c.name, router });
    else require('../../services/chatyyOnlyCalls').callPhoneViaChatyy({ phone: c.phone, email: c.email, name: c.name, router, t });
  } catch {}
}

export async function inviteContact(c, t) {
  const msg = `${c && c.name ? c.name + ', ' : ''}${_tr(t, 'chat.inviteShareMessage', 'instala o Chatyy: https://chatyy.com.br')}`;
  if (c && c.phone && Platform.OS !== 'web') {
    const clean = c.phone.replace(/[^+\d]/g, '');
    const sep = Platform.OS === 'ios' ? '&' : '?';
    try { await Linking.openURL(`sms:${clean}${sep}body=${encodeURIComponent(msg)}`); return; } catch {}
  }
  try { await Share.share({ message: msg, title: 'Chatyy' }); } catch {}
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
  const deny = () => _alert(_tr(t, 'chatConv.permission', 'Permissão'), _tr(t, 'chatConv.contactsPermission', 'Permita acesso aos contatos.'));
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
          if (perm?.status !== 'granted') { deny(); return; }
        }
        await Contacts.presentFormAsync(null, form, { isNew: true });
        ok = true;
      } catch {}
      if (ok) return;
    }
    const { status } = await Contacts.requestPermissionsAsync();
    if (status !== 'granted') { deny(); return; }
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
