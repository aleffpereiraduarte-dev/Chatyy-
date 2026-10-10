// [2026-10-10 wa-import] Parser do "_chat.txt" do "Exportar conversa" do WhatsApp.
//
// Formatos cobertos (iOS e Android, vários idiomas):
//   iOS      "[25/12/23, 21:05:12] Maria: oi"          (colchetes, segundos)
//   iOS US   "[12/25/23, 9:05:12 PM] Maria: oi"
//   Android  "25/12/2023 21:05 - Maria: oi"
//   Android  "12/25/23, 9:05 PM - Maria: oi"            (U+202F antes do AM/PM)
//   DE       "25.12.23, 21:05 - Maria: oi"
//   JA/ISO   "2023/12/25 21:05 - Maria: oi"  "[2023-12-25 21:05:12] Maria: oi"
//   AR       dígitos arábico-índicos + "م/ص"
// Detalhes: mensagens multilinha, sistema (sem "Nome:"), mídia anexada
// ("<attached: …>", "IMG-….jpg (arquivo anexado)"), mídia omitida
// ("<Mídia oculta>", "image omitted"), apagadas, editadas, U+200E/U+200F/U+202A-E.
// Ordem dia/mês decidida pelo arquivo inteiro (valor > 12 decide; senão a ordem
// que deixa a conversa cronológica; senão a dica de idioma).
//
// Saída: { messages, participants, title, dateOrder, platform, stats }
// messages[i] = { idx, tsLocal:'YYYY-MM-DDTHH:MM:SS', sender:string|null,
//   kind:'text'|'system'|'media'|'media_omitted'|'deleted', text, attachment, edited, key }
// key = sha256(tsLocal|sender|kind|text|attachment|n) (n = ocorrência idêntica) —
// estável entre reexportações → servidor deduplica (importar de novo não duplica).

import { sha256Hex } from './sha256';

const BIDI_RE = /[\u200e\u200f‪-‮⁦-⁩\ufeff]/g;
const SPACE_RE = /[\u00a0\u202f  ]/g;

function normalizeDigits(s) {
  return s
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966));
}

// AM/PM tokens (normalizados para minúsculas, sem pontos/espaços).
const PM_TOKENS = ['pm', 'p', 'nachm', 'ptg', 'ل', 'م', 'مساءً', 'مساء', '午後', '下午', '오후', 'ndp', 'ச', 'अपराह्न', 'pd', 'μμ', 'ö.s', 'öö.s'];
const AM_TOKENS = ['am', 'a', 'vorm', 'ptn', 'ص', 'صباحًا', 'صباحا', '午前', '上午', '오전', 'pg', 'पूर्वाह्न', 'pp', 'πμ', 'öö'];
function ampmKind(tok) {
  if (!tok) return null;
  const t = tok.toLowerCase().replace(/[.\s]/g, '');
  if (!t) return null;
  if (t === 'öö') return 'am';
  if (t === 'ös') return 'pm';
  if (PM_TOKENS.includes(t)) return 'pm';
  if (AM_TOKENS.includes(t)) return 'am';
  if (/^p/.test(t) && t.length <= 3) return 'pm';
  if (/^a/.test(t) && t.length <= 3) return 'am';
  return null;
}

const AMPM_SRC = '(?:[aApP]\\.?\\s?[mM]\\.?|vorm\\.|nachm\\.|午前|午後|上午|下午|오전|오후|ص|م|صباحًا|مساءً|صباحا|مساء)';
// Cabeçalho: [data, hora] ou data, hora -   (depois vem o resto).
const HEADER_RE = new RegExp(
  '^\\[?' +
  '(\\d{1,4})[./\\-](\\d{1,2})[./\\-](\\d{1,4})\\.?' +   // data
  '[,\\s]\\s*' +
  '(?:(' + AMPM_SRC + ')\\s?)?' +                       // AM/PM antes (ja/ko/zh)
  '(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2}))?' +           // hora
  '(?:\\s?(' + AMPM_SRC + '))?' +                        // AM/PM depois
  '(\\]\\s?|\\s?[-\\u2013\\u2014]\\s)' +               // fecho
  '([\\s\\S]*)$'
);

const ATTACHED_RE = /^<(?:attached|anexado|adjunto|angehängt|joint|allegato|terlampir|anexo|添付)\s*:\s*([^<>]+)>\s*([\s\S]*)$/i;
// Android: "IMG-20231225-WA0001.jpg (arquivo anexado)" [+ legenda nas linhas seguintes]
const FILE_ATTACHED_RE = /^(\S(?:[^\n]*?\S)?\.[A-Za-z0-9]{2,5})\s+\(([^()\n]{2,40})\)\s*(?:\n([\s\S]*))?$/;
const FILE_ATTACHED_WORDS = /(attach|anexad|adjunt|angeh|joint|allegat|terlampir|添付|ファイル|مرفق|संलग्न|ficheiro|archivo|fichier|datei)/i;

const OMITTED_ANDROID_RE = /^<([^<>\n]{3,60})>$/;
const OMITTED_WORDS = /(omit|ocult|omis|ausgeschlossen|weggelassen|omess|tidak disertakan|dihilangkan|省略|غير مضمن|محذوف|शामिल नहीं|non incluso|no incluid|não incluíd|nicht enthalten|exclu)/i;

const DELETED_TEXTS = [
  'this message was deleted', 'you deleted this message',
  'esta mensagem foi apagada', 'mensagem apagada', 'você apagou esta mensagem', 'voce apagou esta mensagem',
  'mensagem eliminada', 'eliminou esta mensagem', 'esta mensagem foi eliminada',
  'se eliminó este mensaje', 'eliminaste este mensaje', 'este mensaje fue eliminado',
  'diese nachricht wurde gelöscht', 'du hast diese nachricht gelöscht',
  'ce message a été supprimé', 'vous avez supprimé ce message',
  'questo messaggio è stato eliminato', 'hai eliminato questo messaggio',
  'pesan ini telah dihapus', 'anda menghapus pesan ini',
  'このメッセージは削除されました', 'メッセージを削除しました',
  'تم حذف هذه الرسالة', 'لقد حذفت هذه الرسالة',
  'यह संदेश हटा दिया गया था', 'आपने यह संदेश हटा दिया',
];
const EDITED_RE = /\s*<([^<>\n]{4,60})>\s*$/;
const EDITED_WORDS = /(edit|modific|bearbeit|editad|editó|diedit|modifié|編集|تعديل|संपादित)/i;

function cleanLine(raw) {
  return normalizeDigits(String(raw).replace(SPACE_RE, ' ')).replace(/\r$/, '');
}

function stripBidi(s) { return String(s).replace(BIDI_RE, ''); }

function pad2(n) { return String(n).padStart(2, '0'); }

// Separa "Nome: texto". Nome sem quebra de linha, até 80 chars.
function splitSender(rest) {
  const m = /^([^\n:]{1,80}?):\s([\s\S]*)$/.exec(rest);
  if (!m) {
    const m2 = /^([^\n:]{1,80}?):$/.exec(rest); // "Nome:" com texto vazio
    if (m2) return { name: m2[1], body: '' };
    return null;
  }
  return { name: m[1], body: m[2] };
}

/**
 * Detecta e decodifica o texto exportado (BOM, UTF-16).
 */
export function decodeChatBytes(bytes) {
  if (!bytes || !bytes.length) return '';
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xfe) return utf16(b.subarray(2), true);
  if (b[0] === 0xfe && b[1] === 0xff) return utf16(b.subarray(2), false);
  return utf8Decode(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b);
}
function utf16(b, le) {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  return s;
}
export function utf8Decode(b) {
  try {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(b);
  } catch {}
  let out = '';
  let chunk = [];
  for (let i = 0; i < b.length;) {
    const c = b[i];
    let cp;
    if (c < 0x80) { cp = c; i += 1; }
    else if (c >= 0xc0 && c < 0xe0) { cp = ((c & 31) << 6) | (b[i + 1] & 63); i += 2; }
    else if (c >= 0xe0 && c < 0xf0) { cp = ((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); i += 3; }
    else if (c >= 0xf0) { cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63); i += 4; }
    else { cp = 0xfffd; i += 1; }
    if (cp > 0xffff) { cp -= 0x10000; chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
    else chunk.push(cp);
    if (chunk.length > 8000) { out += String.fromCharCode.apply(null, chunk); chunk = []; }
  }
  if (chunk.length) out += String.fromCharCode.apply(null, chunk);
  return out;
}

/**
 * Título da conversa a partir do nome do arquivo exportado.
 *   "WhatsApp Chat - Maria.zip", "WhatsApp Chat with Maria.txt",
 *   "Conversa do WhatsApp com Maria.txt", "Chat de WhatsApp con Maria",
 *   "WhatsApp Chat mit Maria", "Discussion WhatsApp avec Maria", "Chat WhatsApp dengan Maria"
 */
export function titleFromFileName(name) {
  let s = stripBidi(String(name || '')).replace(/^.*[\\/]/, '');
  s = s.replace(/\.(zip|txt)$/i, '').replace(/_/g, ' ').replace(/^\d{9,}\s+/, '').replace(/\s*\(\d+\)\s*$/, '').trim();
  if (!/whats\s?app/i.test(s)) return '';
  const m = /(?:\s-\s|\s(?:with|com|con|mit|avec|dengan|met|z|ile|с|と|مع|के साथ)\s)(.+)$/i.exec(s);
  if (m) return m[1].trim();
  const m2 = /whats\s?app\s*(?:chat)?\s*[-–:]?\s*(.+)$/i.exec(s);
  return m2 && !/^chat$/i.test(m2[1].trim()) ? m2[1].trim() : '';
}

/** true se o texto parece um export do WhatsApp (≥ 2 linhas de cabeçalho nas primeiras 40). */
export function looksLikeWhatsAppChat(text) {
  const lines = String(text || '').split('\n', 60);
  let hits = 0;
  for (const l of lines) { if (HEADER_RE.test(stripBidi(cleanLine(l)))) hits++; if (hits >= 2) return true; }
  return hits >= 1 && lines.filter((l) => l.trim()).length <= 2;
}

/**
 * @param {string} text conteúdo do _chat.txt
 * @param {{ fileName?: string, localeHint?: string, mediaNames?: string[] }} opts
 */
export function parseWhatsAppChat(text, opts = {}) {
  const src = String(text || '').replace(/^\ufeff/, '');
  const rawLines = src.split('\n');
  const mediaSet = new Set((opts.mediaNames || []).map((n) => String(n).replace(/^.*[\\/]/, '').toLowerCase()));

  // 1ª passada: cabeçalhos.
  const entries = []; // { a, b, c, H, M, S, ampm, bracket, rest, extra:[] }
  let cur = null;
  let bracketCount = 0;
  let dashCount = 0;
  for (const raw of rawLines) {
    const line = cleanLine(raw);
    const probe = line.replace(/^[\u200e\u200f‪-‮⁦-⁩\ufeff\s]+/, '');
    const m = HEADER_RE.exec(probe);
    let ok = false;
    if (m) {
      const a = +m[1], b = +m[2], c = +m[3];
      const H = +m[5], M = +m[6];
      const validDate = (a >= 1 && b >= 1 && b <= 31 && c >= 1) && (m[1].length === 4 || a <= 31) && (m[1].length === 4 || c <= 9999);
      ok = validDate && H <= 24 && M <= 59;
      if (ok) {
        const closer = m[9] || '';
        const bracket = probe.startsWith('[') && closer.trim().startsWith(']');
        if (bracket) bracketCount++; else if (/[-–—]/.test(closer)) dashCount++;
        cur = {
          d1: m[1], d2: m[2], d3: m[3], a, b, c, H, M, S: m[7] ? +m[7] : 0,
          ampm: ampmKind(m[4] || m[8]), bracket, rest: m[10] || '', extra: [],
        };
        entries.push(cur);
      }
    }
    if (!ok) {
      if (cur) cur.extra.push(line);
    }
  }

  const platform = bracketCount >= dashCount ? (bracketCount ? 'ios' : 'unknown') : 'android';

  // Ordem da data: ymd | dmy | mdy
  let dateOrder = 'dmy';
  const yearFirst = entries.filter((e) => e.d1.length === 4).length;
  if (yearFirst > entries.length / 2) dateOrder = 'ymd';
  else {
    let aOver12 = 0, bOver12 = 0;
    for (const e of entries) { if (e.a > 12) aOver12++; if (e.b > 12) bOver12++; }
    if (aOver12 && !bOver12) dateOrder = 'dmy';
    else if (bOver12 && !aOver12) dateOrder = 'mdy';
    else {
      // Ambíguo: escolhe a ordem com menos "voltas no tempo"; empate → dica de idioma.
      const inv = (order) => {
        let n = 0, prev = -Infinity;
        for (const e of entries) {
          const t = toNumber(e, order);
          if (t < prev) n++;
          prev = t;
        }
        return n;
      };
      const iD = inv('dmy'), iM = inv('mdy');
      if (iD < iM) dateOrder = 'dmy';
      else if (iM < iD) dateOrder = 'mdy';
      else {
        const hint = String(opts.localeHint || '').toLowerCase();
        dateOrder = /^en(-us)?$|^en-us|^fil|^en_us/.test(hint) ? 'mdy' : 'dmy';
      }
    }
  }

  // 2ª passada: monta mensagens.
  const messages = [];
  const counts = new Map();
  const partCounts = new Map();
  const nameCandidates = new Map();
  for (const e of entries) {
    const sp = splitSender(e.rest);
    if (sp) nameCandidates.set(sp.name.trim(), (nameCandidates.get(sp.name.trim()) || 0) + 1);
  }

  for (const e of entries) {
    const ts = buildTs(e, dateOrder);
    if (!ts) continue;
    let rest = e.rest;
    if (e.extra.length) rest += '\n' + e.extra.join('\n');
    let sender = null;
    let body = rest;
    const sp = splitSender(e.rest);
    if (sp) {
      sender = stripBidi(sp.name).trim();
      body = sp.body + (e.extra.length ? '\n' + e.extra.join('\n') : '');
    }
    const hadMarker = /^[\u200e\u200f]/.test(body);
    body = body.replace(/^[\u200e\u200f‪-‮⁦-⁩]+/, '');
    let kind = 'text';
    let attachment = null;
    let edited = false;
    let text = body;

    // Editada: "<Mensagem editada>" no fim.
    const em = EDITED_RE.exec(stripBidi(text));
    if (em && EDITED_WORDS.test(em[1])) {
      edited = true;
      text = stripBidi(text).replace(EDITED_RE, '');
    }
    const plain = stripBidi(text).trim();

    const at = ATTACHED_RE.exec(plain);
    const fa = !at ? FILE_ATTACHED_RE.exec(plain) : null;
    if (sender === null) {
      kind = 'system';
      text = stripBidi(text).trim();
    } else if (at) {
      kind = 'media';
      attachment = at[1].trim();
      text = (at[2] || '').trim();
    } else if (fa && (FILE_ATTACHED_WORDS.test(fa[2]) || mediaSet.has(fa[1].toLowerCase()))) {
      kind = 'media';
      attachment = fa[1].trim();
      text = (fa[3] || '').trim();
    } else if (DELETED_TEXTS.includes(plain.toLowerCase().replace(/[.。]$/, ''))) {
      kind = 'deleted';
      text = '';
    } else if ((OMITTED_ANDROID_RE.test(plain) && !/^<https?:/i.test(plain)) || (hadMarker && plain.length <= 80 && OMITTED_WORDS.test(plain))) {
      const inner = OMITTED_ANDROID_RE.exec(plain);
      if (!inner || OMITTED_WORDS.test(inner[1]) || /m[ií]dia|media|médias|medien|multimedia|ファイル/i.test(inner[1])) {
        kind = 'media_omitted';
        text = plain;
      }
    } else if (hadMarker && isSystemLike(plain, sender, opts)) {
      // iOS: mensagem de sistema de grupo vem com o NOME DO GRUPO como remetente
      // e o texto começando com U+200E ("\u200eMaria adicionou você").
      kind = 'system';
      text = plain;
      sender = null;
    }
    if (kind === 'text') text = text.replace(/^[\u200e\u200f]+|[\u200e\u200f]+$/g, '');
    if (kind === 'media' && attachment) attachment = attachment.replace(/^.*[\\/]/, '');
    text = String(text || '').replace(/\s+$/, '');

    const sig = `${ts}|${sender || ''}|${kind}|${text}|${attachment || ''}`;
    const n = (counts.get(sig) || 0) + 1;
    counts.set(sig, n);
    const key = sha256Hex(`${sig}|${n}`).slice(0, 40);
    if (sender) partCounts.set(sender, (partCounts.get(sender) || 0) + 1);
    messages.push({ idx: messages.length, tsLocal: ts, sender, kind, text, attachment, edited, key });
  }

  const participants = [...partCounts.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([name, count]) => ({ name, count }));
  const title = titleFromFileName(opts.fileName || '');
  const stats = {
    total: messages.length,
    text: messages.filter((m) => m.kind === 'text').length,
    media: messages.filter((m) => m.kind === 'media').length,
    mediaOmitted: messages.filter((m) => m.kind === 'media_omitted').length,
    system: messages.filter((m) => m.kind === 'system').length,
    deleted: messages.filter((m) => m.kind === 'deleted').length,
    first: messages.length ? messages[0].tsLocal : null,
    last: messages.length ? messages[messages.length - 1].tsLocal : null,
  };
  return { messages, participants, title, dateOrder, platform, stats };
}

function isSystemLike(plain, sender, opts) {
  if (opts && opts.title && sender && stripBidi(sender).trim() === String(opts.title).trim()) return true;
  // Frases típicas de sistema (criptografia, grupo, chamadas perdidas, segurança).
  return /(end-to-end|ponta a ponta|extremo a extremo|ende-zu-ende|de bout en bout|end-to-end|crittograf|enkripsi|created group|criou o grupo|creó el grupo|hat die gruppe|a créé le groupe|ha creato il gruppo|membuat grup|added|adicionou|añadió|hinzugefügt|a ajouté|ha aggiunto|menambahkan|removed|removeu|eliminó|entfernt|a retiré|ha rimosso|left|saiu|salió|verlassen|est parti|ha abbandonato|keluar|changed|mudou|alterou|cambió|geändert|a modifié|ha cambiato|mengubah|missed (voice|video) call|chamada (de voz|de vídeo) perdida|llamada perdida|security code|código de segurança|código de seguridad|sicherheitsnummer|code de sécurité|codice di sicurezza|kode keamanan|disappearing|temporárias|temporales|selbstlöschende|éphémères|effimeri|sementara|joined using|entrou usando|se unió|beigetreten|a rejoint|si è unito|bergabung|pinned a message|fixou uma mensagem|fijó un mensaje)/i.test(plain);
}

function toNumber(e, order) {
  const p = datePartsFor(e, order);
  if (!p) return 0;
  return ((p.y * 13 + p.mo) * 32 + p.d) * 1440 + hour24(e) * 60 + e.M;
}

function datePartsFor(e, order) {
  let y, mo, d;
  if (order === 'ymd') { y = e.a; mo = e.b; d = e.c; }
  else if (order === 'mdy') { mo = e.a; d = e.b; y = e.c; }
  else { d = e.a; mo = e.b; y = e.c; }
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

function hour24(e) {
  let H = e.H;
  if (e.ampm === 'pm' && H < 12) H += 12;
  if (e.ampm === 'am' && H === 12) H = 0;
  if (H === 24) H = 0;
  return H;
}

function buildTs(e, order) {
  const p = datePartsFor(e, order);
  if (!p) return null;
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(hour24(e))}:${pad2(e.M)}:${pad2(e.S)}`;
}

/**
 * Converte o horário local do export (sem fuso) em ISO UTC usando o fuso do aparelho.
 */
export function localTsToIso(tsLocal) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(String(tsLocal || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Tipo de mídia pelo nome do arquivo do WhatsApp (PHOTO/IMG, VIDEO/VID, AUDIO/PTT/AUD, STICKER/STK, GIF, DOC).
 */
export function mediaKindFromName(name) {
  const n = String(name || '').toLowerCase();
  const ext = n.split('.').pop();
  if (/sticker|^stk-/.test(n) || ext === 'webp') return 'sticker';
  if (['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'm4v', '3gp', 'mkv', 'webm'].includes(ext)) return 'video';
  if (['opus', 'ogg', 'm4a', 'aac', 'mp3', 'amr', 'wav'].includes(ext)) return /ptt|audio-|-audio|^aud-/.test(n) || ext === 'opus' ? 'voice' : 'audio';
  if (ext === 'vcf') return 'contact';
  return 'file';
}

/**
 * Sugere qual participante é o próprio usuário.
 *   1) nome igual (sem acento/maiúsculas) ao nome do perfil;
 *   2) 1:1 (2 participantes) com título = um deles → o outro;
 *   3) senão null (a tela pergunta).
 */
export function guessMe(participants, { myName = '', title = '' } = {}) {
  const norm = (s) => stripBidi(String(s || '')).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const names = (participants || []).map((p) => p.name);
  const mine = norm(myName);
  if (mine) {
    const hit = names.find((n) => norm(n) === mine) || names.find((n) => mine && norm(n).split(' ')[0] === mine.split(' ')[0] && names.filter((x) => norm(x).split(' ')[0] === mine.split(' ')[0]).length === 1);
    if (hit) return hit;
  }
  const t = norm(title);
  if (names.length === 2 && t) {
    if (norm(names[0]) === t) return names[1];
    if (norm(names[1]) === t) return names[0];
  }
  return null;
}
