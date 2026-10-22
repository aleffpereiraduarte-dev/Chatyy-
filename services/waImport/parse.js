// [wa-import-local 2026-10-22] Importação do WhatsApp SÓ NO APARELHO — parte PURA (sem react-native).
//
// O parser do "_chat.txt" já é JS no aparelho (./parser: iOS/Android, pt-BR/en/es/…, multilinha,
// "<anexado: …>", "‎imagem omitida", mensagens de sistema, apagadas/editadas, nomes = telefones).
// O servidor NUNCA parseou o export: recebia as mensagens já parseadas e as gravava EM CLARO
// (wa_import_batch). Com E2EE (e o futuro "apagar ao entregar") nada disso pode ir ao servidor →
// este módulo converte o resultado do parser em LINHAS DO STORE LOCAL (tabela messages do
// chatyy.db, a mesma das conversas), como CÓPIA PESSOAL de quem importou:
//   • conversa local (id negativo, ./localIds), arquivada no store → fora da lista principal e
//     nunca sincronizada; marcada imported/import_source → o backup cifrado v4 leva junto
//     (cloudBackup MSG_FIELDS/_convMeta já carregam imported/import_source/original_sender…);
//   • remetentes ≠ eu ganham e-mail SINTÉTICO (…@import.local.invalid) — nunca o e-mail real;
//   • nada aqui fala com a rede.
// Testes: node services/waImport/parse.test.js (amostras sintéticas).

import { parseWhatsAppChat, localTsToIso, mediaKindFromName, decodeChatBytes, looksLikeWhatsAppChat } from './parser';
import { sha256Hex } from './sha256';
import { localConvId, localMsgId, slotFromHex } from './localIds';

export { parseWhatsAppChat, localTsToIso, mediaKindFromName, decodeChatBytes, looksLikeWhatsAppChat };
export * from './localIds';

export const IMPORT_SOURCE = 'whatsapp';
const SYNTH_DOMAIN = 'import.local.invalid';
const MAX_TEXT = 65536;

/** Texto seguro para guardar/mostrar: sem controles nem bidi de override (o RN nunca interpreta HTML). */
export function cleanText(s, max = MAX_TEXT) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[‪-‮⁦-⁩]/g, '')
    .slice(0, max);
}

export function chatKeyLocal(owner, participants, fileTitle) {
  const names = (participants || []).map((p) => String(p?.name || '')).sort().join('|');
  return sha256Hex(`wa-local|${String(owner || '').trim().toLowerCase()}|${String(fileTitle || '').trim().toLowerCase()}|${names}`);
}

export function slotFor(chatKey, probe = 0) { return slotFromHex(chatKey, probe); }

export function syntheticEmail(owner, chatKey, name) {
  return `wa-${sha256Hex(`${String(owner || '').toLowerCase()}|${chatKey}|${String(name || '')}`).slice(0, 16)}@${SYNTH_DOMAIN}`;
}

/** Tipo da linha no store (o mesmo vocabulário das mensagens do chat). */
export function rowType(m) {
  if (!m) return 'text';
  if (m.kind === 'system') return 'system';
  if (m.kind === 'media' && m.attachment) {
    const k = mediaKindFromName(m.attachment);
    if (k === 'contact') return 'file';
    return k; // image | video | voice | audio | sticker | file
  }
  return 'text';
}

/**
 * Mensagens do parser (já em ordem cronológica) → linhas do store local.
 * opts: { slot, chatKey, owner, meName, importedAt (ISO), media: Map<lowerName,{local_path,size,mime,e2ee?}>, startSeq }
 * → [{ id, conversation_id, sender_email, sender_name, type, content, file_name, file_size, local_path,
 *      created_at, imported:1, is_imported:1, import_source, imported_at, original_sender, original_sender_name,
 *      client_message_id, pending_state:'sent', read_at, edited?, deleted?/deleted_at?, media_missing? }]
 * Mensagem sem data válida é descartada (não há onde ordená-la).
 */
export function buildLocalRows(messages, opts = {}) {
  const slot = Number(opts.slot) || 0;
  const convId = localConvId(slot);
  const owner = String(opts.owner || '').toLowerCase();
  const chatKey = String(opts.chatKey || '');
  const meName = opts.meName || null;
  const importedAt = opts.importedAt || new Date().toISOString();
  const media = opts.media instanceof Map ? opts.media : new Map();
  const synth = new Map();
  const emailOf = (name) => {
    if (!name) return '';
    if (meName && name === meName) return owner;
    let e = synth.get(name);
    if (!e) { e = syntheticEmail(owner, chatKey, name); synth.set(name, e); }
    return e;
  };
  const out = [];
  let seq = Number(opts.startSeq) || 0;
  for (const m of messages || []) {
    const created = localTsToIso(m?.tsLocal);
    if (!created) continue;
    seq++;
    const type = rowType(m);
    const sender = m.sender ? cleanText(m.sender, 200) : '';
    const row = {
      id: localMsgId(slot, seq),
      conversation_id: convId,
      sender_email: sender ? emailOf(m.sender) : '',
      sender_name: sender,
      type,
      content: cleanText(m.text || ''),
      created_at: created,
      read_at: created,
      pending_state: 'sent',
      client_message_id: `wal:${m.key || seq}`,
      imported: 1,
      is_imported: 1,
      import_source: IMPORT_SOURCE,
      imported_at: importedAt,
      original_sender: sender || null,
      original_sender_name: sender || null,
    };
    if (meName && m.sender === meName) row.is_mine = 1;
    if (m.edited) { row.edited = 1; row.edited_at = created; }
    if (m.kind === 'deleted') { row.deleted = 1; row.deleted_at = created; row.content = ''; }
    if (m.kind === 'media_omitted') row.media_omitted = 1;
    if (m.kind === 'media' && m.attachment) {
      const name = cleanText(m.attachment, 180);
      row.file_name = name;
      const got = media.get(name.toLowerCase());
      if (got && got.local_path) {
        row.local_path = got.local_path;
        if (got.size) row.file_size = Number(got.size) || 0;
        if (got.mime) row.mime = got.mime;
        if (got.e2ee) row.e2ee_media = got.e2ee; // [flag upload cifrado] objeto M do WP-11 (com a chave) — só no aparelho/backup cifrado
      } else {
        row.media_missing = 1;
      }
    }
    out.push(row);
  }
  return out;
}

/** Linha da conversa local (raw_json do store). */
export function buildLocalConversation(o = {}) {
  const slot = Number(o.slot) || 0;
  const participants = (o.participants || []).map((p) => ({ name: cleanText(p?.name || '', 200), count: Number(p?.count) || 0, is_me: !!(o.meName && p?.name === o.meName) }));
  const last = o.lastRow || null;
  return {
    id: localConvId(slot),
    type: o.isGroup || participants.length > 2 ? 'group' : 'direct',
    name: cleanText(o.title || 'WhatsApp', 80) || 'WhatsApp',
    archived: 1,
    imported: 1,
    is_imported: 1,
    import_source: IMPORT_SOURCE,
    local_only: 1,
    chat_key: o.chatKey || '',
    import_slot: slot,
    imported_at: o.importedAt || new Date().toISOString(),
    platform: o.platform || '',
    participants,
    me_name: o.meName || '',
    message_count: Number(o.messageCount) || 0,
    media_count: Number(o.mediaCount) || 0,
    first_at: o.firstAt || null,
    last_at: o.lastAt || (last ? last.created_at : null),
    // a "data da última mensagem" do store = hora da importação (fica entre as recentes no store,
    // que lista as 200 mais novas) — a data real do export está em last_at.
    last_message_time: o.importedAt || new Date().toISOString(),
    last_message: last ? (last.content || last.file_name || '') : '',
    last_message_sender: last ? last.sender_email || '' : '',
    status: o.status || 'done',
  };
}

/** Atalho para testes / texto colado: texto do export → {conversation, rows}. */
export function parseToLocal(text, opts = {}) {
  const parsed = parseWhatsAppChat(text, { fileName: opts.fileName || '', localeHint: opts.localeHint || '', mediaNames: opts.mediaNames || [] });
  const msgs = parsed.messages.slice().sort((a, b) => (a.tsLocal < b.tsLocal ? -1 : a.tsLocal > b.tsLocal ? 1 : a.idx - b.idx));
  const chatKey = opts.chatKey || chatKeyLocal(opts.owner, parsed.participants, opts.fileTitle || '');
  const slot = opts.slot != null ? opts.slot : slotFor(chatKey);
  const rows = buildLocalRows(msgs, { ...opts, slot, chatKey });
  const conversation = buildLocalConversation({
    slot, chatKey, title: opts.title || parsed.title || 'WhatsApp', isGroup: parsed.isGroup, participants: parsed.participants,
    meName: opts.meName, importedAt: opts.importedAt, platform: parsed.platform, messageCount: rows.length,
    mediaCount: rows.filter((r) => r.local_path).length, firstAt: rows[0]?.created_at, lastRow: rows[rows.length - 1],
  });
  return { parsed, conversation, rows };
}
