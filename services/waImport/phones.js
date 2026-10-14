// services/waImport/phones.js — [wa-phone 2026-10-14] Match pelo NÚMERO (prioridade máxima sobre nome).
// O export do WhatsApp (iPhone) traz no remetente o nome COMO SALVO NA AGENDA ("Sara Zelle") ou o próprio
// número quando o contato não está salvo. Aqui:
//   1) remetente que já é número → E.164 (parser.senderPhoneE164);
//   2) senão → contato da agenda do aparelho com o MESMO nome (match.agendaPhonesFor) → telefones dele;
//   3) só HASHES sha256(E.164) saem do aparelho (mesmo esquema do chat_phone_registry / chat_sync_contacts).
// Números ficam só em memória durante a chamada; nada é salvo. Agenda negada → segue só com nome.
import { Platform, Alert, Linking } from 'react-native';
import { isPhoneName, senderPhoneE164, phoneLike } from './parser';
import { agendaPhonesFor } from './match';
import { sha256Hex } from './sha256';

const AGENDA_TTL = 5 * 60 * 1000;
const MAX_HASHES = 16; // por autor (o servidor também corta em 16)
const SELF_WORDS = ['voce', 'você', 'you', 'eu', 'me'];
let _agenda = null; // { at, list } — só memória
let _asked = false; // explicação mostrada nesta sessão (não insiste)
let _importConsent = false; // "Permitir" na explicação do importador (só esta sessão; não liga a descoberta de contatos)
let _settingsOffered = false;

function _cs() { return require('../contactSync'); }

/** Variantes de um número do export já em E.164 (BR com/sem o 9º dígito). */
function exportVariants(e164) {
  const out = [e164];
  const m = /^\+55(\d{2})(\d+)$/.exec(e164);
  if (m) {
    const n = m[2];
    if (n.length === 9 && n[0] === '9') out.push('+55' + m[1] + n.slice(1));
    else if (n.length === 8 && /[6-9]/.test(n[0])) out.push('+55' + m[1] + '9' + n);
  }
  return out;
}

function _explain(t) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    Alert.alert(t('waImport.agendaAskTitle'), t('waImport.agendaAskBody'), [
      { text: t('waImport.agendaNotNow'), style: 'cancel', onPress: () => end(false) },
      { text: t('waImport.agendaAllow'), onPress: () => end(true) },
    ], { cancelable: true, onDismiss: () => end(false) });
  });
}

/** 'ok' | 'denied' | 'unavailable'. ask=false → nunca mostra diálogo. */
async function ensureAgendaAccess(t, ask) {
  if (Platform.OS === 'web') return 'unavailable';
  const cs = _cs();
  let consent = null;
  try { consent = await cs.getContactsConsentState(); } catch {}
  if (consent !== 'granted' && !_importConsent) {
    if (!ask || _asked || typeof t !== 'function') return 'denied';
    _asked = true;
    if (!(await _explain(t))) return 'denied';
    _importConsent = true;
  }
  try { if (await cs.hasContactsPermissionNoPrompt()) return 'ok'; } catch {}
  if (!ask) return 'denied';
  let Contacts = null;
  try { Contacts = require('expo-contacts'); } catch { return 'unavailable'; }
  try {
    const r = await Contacts.requestPermissionsAsync();
    if (r?.status === 'granted' || r?.accessPrivileges === 'limited') return 'ok';
    if (r?.canAskAgain === false && !_settingsOffered && typeof t === 'function') {
      _settingsOffered = true;
      Alert.alert(t('waImport.agendaAskTitle'), t('waImport.agendaDeniedHint'), [
        { text: t('waImport.agendaNotNow'), style: 'cancel' },
        { text: t('waImport.agendaOpenSettings'), onPress: () => { try { Linking.openSettings(); } catch {} } },
      ]);
    }
  } catch {}
  return 'denied';
}

async function loadAgenda() {
  if (_agenda && Date.now() - _agenda.at < AGENDA_TTL) return _agenda.list;
  let list = null;
  try {
    const Contacts = require('expo-contacts');
    const F = Contacts.Fields || {};
    const fields = [F.Name, F.FirstName, F.MiddleName, F.LastName, F.Nickname, F.Company, F.PhoneNumbers].filter(Boolean);
    const { data } = await Contacts.getContactsAsync({ fields });
    list = (data || []).filter((c) => c?.phoneNumbers?.length).map((c) => ({
      name: c.name || '', firstName: c.firstName || '', middleName: c.middleName || '', lastName: c.lastName || '',
      nickname: c.nickname || '', company: c.company || '',
      phones: c.phoneNumbers.map((p) => p?.number || p?.digits || '').filter(Boolean),
    }));
  } catch {}
  if (!list && Platform.OS === 'ios') {
    try {
      const N = require('../../modules/expo-native-contacts').default;
      const all = await N.getAllContacts();
      list = (all || []).filter((c) => c?.phones?.length).map((c) => ({ name: c.name || '', phones: c.phones }));
    } catch {}
  }
  _agenda = { at: Date.now(), list: list || [] };
  return _agenda.list;
}

function _tail(phones) {
  const tails = Array.from(new Set(phones.map((p) => String(p).replace(/\D/g, '')).filter((d) => d.length >= 4).map((d) => d.slice(-2))));
  return tails.length === 1 ? tails[0] : '';
}

/**
 * participants: [{name}|string] → {
 *   byName: { [autor]: { hashes, src: 'export'|'agenda', tail } },
 *   participantPhones: [{ name, hashes }]  (o que vai pro servidor — SÓ hashes),
 *   agenda: 'ok'|'denied'|'unavailable'|'skipped', meName (autor com o MEU número, ou null), consentGlobal
 * }
 */
export async function resolveParticipantPhones(participants, { t, myPhone = '', ask = true } = {}) {
  const names = (participants || []).map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean).slice(0, 20);
  const cs = _cs();
  let homeDial = '55';
  try { homeDial = cs.getHomeDialDigits(); } catch {}
  const byName = {};
  const mine = [];
  const add = (name, phones, src, candidatesOf) => {
    const hs = [];
    for (const ph of phones) {
      for (const e of candidatesOf(ph)) {
        const h = sha256Hex(e);
        if (h && !hs.includes(h)) hs.push(h);
      }
    }
    if (!hs.length) return;
    byName[name] = { hashes: hs.slice(0, MAX_HASHES), src, tail: _tail(phones) };
    if (myPhone && phones.some((p) => phoneLike(p, myPhone))) mine.push(name);
  };
  const nat = (ph) => { try { return cs.e164Candidates(ph, homeDial); } catch { return []; } };

  const wantsAgenda = [];
  for (const n of names) {
    if (isPhoneName(n)) {
      const e = senderPhoneE164(n);
      add(n, [e || n], 'export', (ph) => (e ? exportVariants(e) : nat(ph)));
    } else if (!SELF_WORDS.includes(String(n).trim().toLowerCase())) {
      wantsAgenda.push(n);
    }
  }
  let agenda = 'skipped';
  if (wantsAgenda.length) {
    agenda = await ensureAgendaAccess(t, ask);
    if (agenda === 'ok') {
      const list = await loadAgenda();
      for (const n of wantsAgenda) {
        const phones = agendaPhonesFor(n, list);
        if (phones.length) add(n, phones, 'agenda', nat);
      }
    }
  }
  let consentGlobal = false;
  try { consentGlobal = (await cs.getContactsConsentState()) === 'granted'; } catch {}
  return {
    byName,
    participantPhones: Object.keys(byName).map((name) => ({ name, hashes: byName[name].hashes })),
    agenda,
    meName: mine.length === 1 ? mine[0] : null,
    consentGlobal,
  };
}

/**
 * Servidor ainda sem o patch (sem phones_ok): resolve os hashes da AGENDA pela descoberta de contatos que já
 * existe (chat_sync_contacts — mesmos filtros/limites). Só com o consentimento global da descoberta.
 * → candidatos no formato do wa_import_match (reason 'contact_phone', score 100).
 */
export async function lookupViaDiscovery(byName) {
  const h2n = {};
  const all = [];
  for (const [n, v] of Object.entries(byName || {})) {
    if (v.src !== 'agenda') continue;
    for (const h of v.hashes) { if (!h2n[h]) { h2n[h] = []; all.push(h); } h2n[h].push(n); }
  }
  if (!all.length) return [];
  let r = null;
  try { r = await require('../api').chatSyncContacts(all.slice(0, 500)); } catch {}
  if (!r?.success) return [];
  const out = new Map();
  for (const m of r.data?.matches || []) {
    const em = String(m?.email || '').toLowerCase();
    if (!em) continue;
    for (const n of h2n[m.phone_hash] || []) {
      if (!out.has(em)) out.set(em, { email: em, name: m.name || em, conversation_id: 0, reason: 'contact_phone', score: 100, matched: n, phone_tail: byName[n]?.tail || '' });
    }
  }
  return Array.from(out.values());
}

export default { resolveParticipantPhones, lookupViaDiscovery };
