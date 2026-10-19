// [2026-10-19 convite-wa] Agenda → lista de convite nível WhatsApp.
//
// A agenda real tem lixo: "-amiga", ":3", ".", "…", "\"Mannyhl\"", "*Entretenimento*",
// "🍀 Debora", "+40". Antes a lista ordenava por localeCompare cru → símbolos e
// emojis no topo e nomes sem letra nenhuma como título. Aqui:
//   • nome de exibição sem pontuação solta na frente / aspas e asteriscos em volta;
//   • chave de ordenação = primeira LETRA em diante (sem emoji/acentos);
//   • seção A–Z; o resto (outras escritas, sem nome) vai para "#", no fim;
//   • sem letra nenhuma no nome → título = número formatado ("+55 33 99804-8586").
// Puro JS (sem \p{L}: nada de depender do suporte a Unicode property escapes do Hermes).

const ACCENTS = {
  á: 'a', à: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a', ā: 'a',
  é: 'e', è: 'e', ê: 'e', ë: 'e', ē: 'e',
  í: 'i', ì: 'i', î: 'i', ï: 'i', ī: 'i',
  ó: 'o', ò: 'o', ô: 'o', õ: 'o', ö: 'o', ø: 'o', ō: 'o',
  ú: 'u', ù: 'u', û: 'u', ü: 'u', ū: 'u',
  ç: 'c', ñ: 'n', ý: 'y', ÿ: 'y', ß: 's',
};

/** "Ângela" → "angela" (minúsculas, sem acento latino). */
export function foldText(s) {
  const low = String(s || '').toLowerCase();
  let out = '';
  for (const ch of low) out += ACCENTS[ch] || ch;
  return out;
}

function isEmojiOrSymbol(cp) {
  return (cp >= 0x2000 && cp <= 0x2bff) // pontuação geral, setas, símbolos, dingbats
    || (cp >= 0x3000 && cp <= 0x303f)
    || (cp >= 0xfe00 && cp <= 0xfe0f) // seletores de variação
    || cp === 0x200d
    || (cp >= 0x1f000 && cp <= 0x1faff) // emojis
    || (cp >= 0xe000 && cp <= 0xf8ff); // uso privado
}

/** Letra "de verdade": latina/cirílica/grega (tem maiúscula) ou escrita sem caixa (árabe, CJK…). */
export function isLetterChar(ch) {
  if (!ch) return false;
  if (ch.toLowerCase() !== ch.toUpperCase()) return true;
  const cp = ch.codePointAt(0) || 0;
  if (cp < 0x0590) return false; // ASCII/latin sem caixa = dígito/pontuação
  return !isEmojiOrSymbol(cp);
}

const LEAD_JUNK = /^[\s\-–—.,:;*"'`~_|!?·•()[\]{}<>/\\]+/;
const TRAIL_JUNK = /[\s\-–—.,:;*"'`~_|]+$/;

/** { display, sortKey, letter, named } a partir do nome salvo na agenda. */
export function cleanContactName(raw) {
  const name = String(raw || '').trim();
  if (!name || name === 'Unknown') return { display: '', sortKey: '', letter: '#', named: false };
  let hasLetter = false;
  for (const ch of name) { if (isLetterChar(ch)) { hasLetter = true; break; } }
  if (!hasLetter) return { display: '', sortKey: '', letter: '#', named: false };
  let display = name.replace(LEAD_JUNK, '').replace(TRAIL_JUNK, '').trim() || name;
  // chave = da 1ª letra em diante, sem emoji/símbolos
  let key = '';
  let started = false;
  for (const ch of display) {
    if (!started) { if (!isLetterChar(ch)) continue; started = true; }
    const cp = ch.codePointAt(0) || 0;
    if (isEmojiOrSymbol(cp)) continue;
    key += ch;
  }
  key = foldText(key).replace(/\s+/g, ' ').trim();
  const first = key.charAt(0);
  const letter = first >= 'a' && first <= 'z' ? first.toUpperCase() : '#';
  return { display, sortKey: key, letter, named: true };
}

/** Iniciais p/ o círculo do avatar ("Ana Paula Souza" → "AS"). */
export function initialsOf(display) {
  const words = String(display || '').split(/\s+/).map((w) => {
    for (const ch of w) { if (isLetterChar(ch)) return ch.toUpperCase(); }
    return '';
  }).filter(Boolean);
  if (!words.length) return '';
  return words.length === 1 ? words[0] : words[0] + words[words.length - 1];
}

// ── telefone ────────────────────────────────────────────────────────────────
function homeDial() {
  try { return require('./contactSync').getHomeDialDigits() || '55'; } catch { return '55'; }
}

/** Número da agenda → dígitos internacionais (wa.me / sms). */
export function intlDigits(raw) {
  const s = String(raw || '').trim();
  let d = s.replace(/\D+/g, '');
  if (!d) return '';
  if (s.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  const home = homeDial();
  d = d.replace(/^0+/, '');
  if (d.startsWith(home) && d.length >= 12) return d;
  return home + d;
}

const CC2 = new Set(['20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86',
  '90', '91', '92', '93', '94', '95', '98']);

function groupDigits(s) {
  if (s.length <= 4) return s;
  const parts = [];
  let i = 0;
  const rest = s.length % 3;
  if (rest === 1 && s.length > 4) { parts.push(s.slice(0, 4)); i = 4; } else if (rest === 2) { parts.push(s.slice(0, 2)); i = 2; }
  for (; i < s.length; i += 3) parts.push(s.slice(i, i + 3));
  return parts.join(' ');
}

/** "+5533998048586" → "+55 33 99804-8586"; "+19548950393" → "+1 (954) 895-0393". */
export function formatPhone(raw) {
  const d = intlDigits(raw);
  if (!d || d.length < 7) return String(raw || '').trim();
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const dd = d.slice(2, 4);
    const n = d.slice(4);
    return `+55 ${dd} ${n.slice(0, n.length - 4)}-${n.slice(-4)}`;
  }
  if (d.startsWith('1') && d.length === 11) return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.startsWith('351') && d.length === 12) return `+351 ${d.slice(3, 6)} ${d.slice(6, 9)} ${d.slice(9)}`;
  const ccLen = d.startsWith('7') ? 1 : CC2.has(d.slice(0, 2)) ? 2 : 3;
  return `+${d.slice(0, ccLen)} ${groupDigits(d.slice(ccLen))}`;
}

function cmp(a, b) {
  try { return a.localeCompare(b, 'pt-BR', { sensitivity: 'base', numeric: true }); } catch { return a < b ? -1 : a > b ? 1 : 0; }
}

/**
 * Lista crua (otherContacts do contactSync) → contatos limpos, sem duplicata
 * (últimos 9 dígitos), ordenados A–Z com "#" no fim.
 */
export function prepareInviteContacts(others) {
  const seen = new Set();
  const out = [];
  for (const c of others || []) {
    const phone = String(c?.phone || '').trim();
    const digits = phone.replace(/\D+/g, '');
    if (!phone || digits.length < 8) continue;
    const k = digits.slice(-9);
    if (seen.has(k)) continue;
    seen.add(k);
    const nm = cleanContactName(c?.name);
    const pretty = formatPhone(phone);
    out.push({
      key: 'p' + k,
      phone,
      digits: intlDigits(phone),
      phoneLabel: pretty,
      display: nm.named ? nm.display : pretty,
      sortKey: nm.named ? nm.sortKey : '~' + digits,
      letter: nm.letter,
      named: nm.named,
      // sem letra no nome (":3", "…", "+40") → o que estava salvo vira legenda discreta
      rawName: !nm.named ? String(c?.name || '').trim().replace(/^Unknown$/, '') : '',
      initials: nm.named ? initialsOf(nm.display) : '',
      search: foldText(nm.named ? nm.display : '') + ' ' + digits,
    });
  }
  out.sort((a, b) => {
    if (a.letter !== b.letter) {
      if (a.letter === '#') return 1;
      if (b.letter === '#') return -1;
      return a.letter < b.letter ? -1 : 1;
    }
    if (a.named !== b.named) return a.named ? -1 : 1;
    return cmp(a.sortKey, b.sortKey);
  });
  return out;
}

/** chatyContacts (já no Chatyy) → limpos, sem o próprio e sem duplicata por e-mail. */
export function prepareChatyyContacts(list, myEmail) {
  const me = String(myEmail || '').toLowerCase();
  const seen = new Set();
  const out = [];
  for (const c of list || []) {
    const email = String(c?.email || '').toLowerCase();
    if (!email || email === me || seen.has(email)) continue;
    seen.add(email);
    const nm = cleanContactName(c?.name);
    const phoneLabel = c?.phone ? formatPhone(c.phone) : '';
    const display = nm.named ? nm.display : (phoneLabel || email.split('@')[0]);
    out.push({
      key: 'e' + email,
      email,
      avatar: c?.avatar || null,
      display,
      phoneLabel,
      sortKey: nm.named ? nm.sortKey : '~' + display,
      search: foldText(display) + ' ' + String(c?.phone || '').replace(/\D+/g, '') + ' ' + email,
    });
  }
  out.sort((a, b) => cmp(a.sortKey, b.sortKey));
  return out;
}

/** Filtro da busca: nome sem acento OU dígitos do número. */
export function matchesQuery(item, q) {
  const f = foldText(String(q || '').trim());
  if (!f) return true;
  if (item.search.indexOf(f) >= 0) return true;
  const qd = f.replace(/\D+/g, '');
  return qd.length >= 3 && item.search.replace(/\D+/g, '').indexOf(qd) >= 0;
}

// ── "Convidado" (lembrado por 30 dias, por número) ──────────────────────────
const SENT_KEY = 'invite_sent_v1';
const SENT_TTL = 30 * 86400000;
export function getInvitedMap() {
  try {
    const kv = require('./mmkv');
    const m = kv.getJSON(SENT_KEY);
    if (!m || typeof m !== 'object') return {};
    const now = Date.now();
    const out = {};
    for (const k of Object.keys(m)) if (now - (Number(m[k]) || 0) < SENT_TTL) out[k] = m[k];
    return out;
  } catch { return {}; }
}
export function markInvited(key) {
  try {
    const kv = require('./mmkv');
    const m = getInvitedMap();
    m[key] = Date.now();
    kv.setJSON(SENT_KEY, m);
  } catch {}
}

export default {
  foldText, cleanContactName, initialsOf, intlDigits, formatPhone,
  prepareInviteContacts, prepareChatyyContacts, matchesQuery, getInvitedMap, markInvited,
};
