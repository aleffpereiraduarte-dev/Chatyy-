// [wa-import-local 2026-10-22] Importação do WhatsApp SÓ NO APARELHO (compatível com E2EE).
//
// Decisão do founder: com E2EE (e o futuro "apagar ao entregar") o export do WhatsApp não pode mais
// virar TEXTO EM CLARO no servidor (wa_import_batch). Aqui:
//   1. o .zip/.txt é lido e parseado no aparelho (importer.prepareImport → parser.js, como antes);
//   2. as mensagens vão SÓ para o store local (chatyy.db: tabelas conversations/messages, as mesmas
//      das conversas), como CÓPIA PESSOAL de quem importou (parse.js: conversa local de id negativo,
//      arquivada no store, marcada imported/import_source='whatsapp'; outros autores = e-mail sintético).
//      Nada é enviado ao outro participante nem ao servidor;
//   3. mídia do zip: copiada para documentDirectory/wa-import-local/<slot>/ (padrão: só local).
//      Atrás de globalThis.__chatyy_wa_import_media_e2ee === true: TAMBÉM cifrada no aparelho e enviada
//      como anexo E2EE (WP-11, e2ee5Media.buildMedia — mesmo formato de anexo cifrado), objeto M (com a
//      chave) guardado só na linha local (e2ee_media);
//   4. o backup cifrado v4 (cloudBackup) lê o store local (db.dbGetConversations(true) + dbGetMessages)
//      → a conversa importada entra no backup (campos imported/import_source/original_sender já previstos lá).
//
// FLAG: globalThis.__chatyy_wa_import_local — true liga, false desliga; ausente = ligado só quando o
// E2EE v5 está ativo nesta conta (globalThis.__chatyy_e2ee5 === true, posto pelo e2ee/accountFlag).
// Web: nunca (não há store SQLite) → fluxo antigo (o servidor recusa conteúdo de conta com E2EE).
import { Platform } from 'react-native';
import {
  buildLocalRows, buildLocalConversation, chatKeyLocal, slotFor, localConvId, slotOfConvId,
  isLocalImportConvId, localTsToIso, CONV_BASE, SLOTS,
} from './parse';

const BATCH = 500;
const MEDIA_REWRITE_EVERY = 25;
const DISK_RESERVE = 200 * 1024 * 1024;
const MSG_COLS = `(id, conversation_id, sender_email, sender_name, content, type,
  file_url, file_name, file_size, reply_to_id, message_id,
  read_at, edited_at, deleted, deleted_at, reactions, read_by,
  created_at, sync_seq, local_seq, client_temp_id, pending_state,
  local_path, media_width, media_height, media_duration, raw_json, account_email)`;
const MSG_VALS = `(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, 0, 0, ?, 'sent', ?, NULL, NULL, NULL, ?, ?)`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function _g() { return typeof globalThis !== 'undefined' ? globalThis : global; }
function _err(code, extra) { return Object.assign(new Error(code), { reason: code }, extra || {}); }
function _db() { return require('../db'); }
function _fs() { try { return require('expo-file-system/legacy'); } catch { return null; } }
function _acct() {
  try { const d = _db().dbGetActiveAccount?.(); if (d) return String(d).toLowerCase(); } catch {}
  try { return String(require('../api').getActiveAccountEmail?.() || '').trim().toLowerCase(); } catch { return ''; }
}

/** A importação vai para o aparelho (e não para o servidor)? */
export function isLocalImportOn() {
  if (Platform.OS === 'web') return false;
  try {
    const f = _g().__chatyy_wa_import_local;
    if (f === true) return true;
    if (f === false) return false;
    return _g().__chatyy_e2ee5 === true;
  } catch { return false; }
}
/** Upload cifrado (WP-11) da mídia importada — desligado por padrão (só local). */
export function isMediaUploadOn() { try { return _g().__chatyy_wa_import_media_e2ee === true; } catch { return false; } }

export { isLocalImportConvId };

async function _handle() {
  const d = _db();
  let h = d.getDb?.();
  if (!h) { try { await Promise.race([d.waitForDb?.(), sleep(5000)]); } catch {} h = d.getDb?.(); }
  return h || null;
}

function _mediaDir(slot) {
  const FS = _fs();
  return FS?.documentDirectory ? `${FS.documentDirectory}wa-import-local/${slot}/` : null;
}
function _safeFile(name) { return String(name || 'arquivo').replace(/^.*[\\/]/, '').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '_').slice(-120) || 'arquivo'; }

async function _writeConversation(conv, account) {
  const d = _db();
  await d.dbRunSerialized('waImportLocalConv', async (db) => {
    await db.runAsync(
      `INSERT OR REPLACE INTO conversations (id, name, type, last_message, last_message_time, last_message_sender, unread_count, avatar_url, pinned, muted, archived, is_group, member_count, description, updated_at, raw_json, account_email)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0, 0, 1, ?, ?, NULL, ?, ?, ?)`,
      [conv.id, conv.name, conv.type, String(conv.last_message || '').slice(0, 300), conv.last_message_time, conv.last_message_sender || '',
        conv.type === 'group' ? 1 : 0, (conv.participants || []).length, conv.last_message_time, JSON.stringify(conv), account || null],
    );
  });
}

async function _writeRows(rows, account) {
  if (!rows.length) return;
  const d = _db();
  await d.dbRunSerialized('waImportLocalMsgs', async (db) => {
    const st = await db.prepareAsync(`INSERT OR REPLACE INTO messages ${MSG_COLS} VALUES ${MSG_VALS}`);
    try {
      for (const r of rows) {
        await st.executeAsync([
          r.id, r.conversation_id, r.sender_email || '', r.sender_name || '', r.content || '', r.type || 'text',
          '', r.file_name || '', Number(r.file_size) || 0,
          r.read_at || null, r.edited_at || null, r.deleted ? 1 : 0, r.deleted_at || null,
          r.created_at || '', r.client_message_id || null, r.local_path || null,
          JSON.stringify(r), account || null,
        ]);
      }
    } finally { try { await st.finalizeAsync(); } catch {} }
  });
}

async function _findSlot(db, chatKey, account) {
  for (let probe = 0; probe < 64; probe++) {
    const s = slotFor(chatKey, probe);
    let row = null;
    try { row = await db.getFirstAsync('SELECT raw_json, account_email FROM conversations WHERE id = ?', [localConvId(s)]); } catch {}
    if (!row) return { slot: s, existing: null };
    let j = null; try { j = JSON.parse(row.raw_json); } catch {}
    if (j && j.chat_key === chatKey && (!row.account_email || row.account_email === account)) return { slot: s, existing: j };
  }
  throw _err('local_slots_full');
}

async function _freeBytes() {
  try { const n = await _fs()?.getFreeDiskStorageAsync?.(); return Number.isFinite(n) ? n : null; } catch { return null; }
}

async function _waitIfPaused(signal) { while (signal.paused && !signal.cancelled) await sleep(400); }

/**
 * Mesmo contrato do importer.runImport (o job e a tela não mudam):
 *   onProgress({ phase, sent, total, mediaDone, mediaTotal, frac, etaSec, conversationId, mode:'local' })
 *   → { conversationId, mode:'local', local:true, summary, cancelled? }
 */
export async function runLocalImport(prep, opts = {}, onProgress, signal = {}) {
  if (!isLocalImportOn() && !opts.forceLocal) throw _err('local_off');
  const db = await _handle();
  if (!db) throw _err('local_store_unavailable');
  const account = _acct() || String(opts.email || '').toLowerCase();
  if (!account) throw _err('auth', { status: 401 });
  const meName = opts.meName || null;
  const title = String(opts.title || prep.title || 'WhatsApp').slice(0, 80);
  const chatKey = chatKeyLocal(account, prep.participants, prep.fileTitle || '');
  const { slot, existing } = await _findSlot(db, chatKey, account);
  const conversationId = localConvId(slot);
  const importedAt = new Date().toISOString();
  const msgs = (prep.messages || []).filter((m) => m && localTsToIso(m.tsLocal));
  if (!msgs.length) throw _err('no_messages');
  const seqOf = new Map(); msgs.forEach((m, i) => seqOf.set(m, i + 1));
  const mediaMsgs = msgs.filter((m) => m.kind === 'media' && m.attachment && prep.media?.has?.(m.attachment.toLowerCase()));
  const total = msgs.length;
  const mediaTotal = mediaMsgs.length;
  const t0 = Date.now();
  const wText = mediaTotal ? 0.25 : 1;
  const emit = (phase, sent, mediaDone) => {
    const frac = Math.min(1, wText * (sent / total) + (1 - wText) * (mediaTotal ? mediaDone / mediaTotal : 0));
    const el = (Date.now() - t0) / 1000;
    const etaSec = frac > 0.03 && el > 2 ? Math.max(0, Math.round(el / frac - el)) : null;
    try { onProgress?.({ phase, sent, total, mediaDone, mediaTotal, frac, etaSec, conversationId, mode: 'local' }); } catch {}
  };
  const baseConv = {
    slot, chatKey, title, isGroup: !!prep.isGroup, participants: prep.participants, meName, importedAt: existing?.imported_at || importedAt,
    platform: prep.platform || '', firstAt: localTsToIso(msgs[0].tsLocal), lastAt: localTsToIso(msgs[msgs.length - 1].tsLocal),
  };
  const rowOpts = { slot, chatKey, owner: account, meName, importedAt: baseConv.importedAt };
  // registro primeiro (status running) → aparece em "Importações neste aparelho" mesmo se o app cair
  await _writeConversation(buildLocalConversation({ ...baseConv, status: 'running', messageCount: 0, mediaCount: 0 }), account);

  const summary = { messages: 0, photos: 0, videos: 0, audios: 0, stickers: 0, docs: 0, missing: 0, failed: 0, blocked: Number(prep.stats?.blocked) || 0, alreadyThere: 0 };
  const done = (cancelled) => ({ conversationId, mode: 'local', local: true, verified: '', summary, ...(cancelled ? { cancelled: true } : {}) });

  // ── Fase A: todas as mensagens (texto primeiro; a mídia entra na fase B) ─────────
  let lastRow = null;
  let sent = 0;
  emit('messages', 0, 0);
  for (let i = 0; i < msgs.length; i += BATCH) {
    await _waitIfPaused(signal);
    if (signal.cancelled) {
      await _writeConversation(buildLocalConversation({ ...baseConv, status: 'partial', messageCount: sent, mediaCount: 0, lastRow }), account).catch(() => {});
      return done(true);
    }
    const rows = buildLocalRows(msgs.slice(i, i + BATCH), { ...rowOpts, startSeq: i });
    await _writeRows(rows, account);
    sent += rows.length;
    lastRow = rows[rows.length - 1] || lastRow;
    emit('messages', sent, 0);
    await sleep(0);
  }
  summary.messages = sent;
  summary.missing = (Number(prep.stats?.mediaMissing) || 0) + (Number(prep.stats?.mediaOmitted) || 0);
  // reimportação de um export MENOR (mesmo chat) → some o que sobrou da importação anterior
  try {
    const d = _db();
    await d.dbRunSerialized('waImportLocalTrim', (h) => h.runAsync('DELETE FROM messages WHERE conversation_id = ? AND id > ?', [conversationId, lastRow.id]));
  } catch {}
  await _writeConversation(buildLocalConversation({ ...baseConv, status: mediaTotal ? 'media' : 'done', messageCount: sent, mediaCount: 0, lastRow }), account);

  // ── Fase B: mídia do zip → arquivo local (+ anexo cifrado, atrás da flag) ─────────
  const FS = _fs();
  const dir = _mediaDir(slot);
  let mediaDone = 0;
  let mediaOk = 0;
  if (mediaTotal && FS && dir) {
    try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
    const need = mediaMsgs.reduce((a, m) => a + (Number(prep.media.get(m.attachment.toLowerCase())?.size) || 0), 0);
    const free = await _freeBytes();
    const noSpace = free != null && free < need + DISK_RESERVE;
    const upload = isMediaUploadOn();
    const pending = [];
    const flush = async () => {
      if (!pending.length) return;
      const rows = [];
      for (const { m, got } of pending.splice(0)) {
        const r = buildLocalRows([m], { ...rowOpts, startSeq: seqOf.get(m) - 1, media: new Map([[m.attachment.toLowerCase(), got]]) })[0];
        if (r) rows.push(r);
      }
      await _writeRows(rows, account);
    };
    for (const m of mediaMsgs) {
      await _waitIfPaused(signal);
      if (signal.cancelled) { await flush().catch(() => {}); break; }
      const ref = prep.media.get(m.attachment.toLowerCase());
      if (noSpace) { summary.failed++; mediaDone++; emit('media', sent, mediaDone); continue; }
      const dest = dir + _safeFile(ref.name);
      let ok = false;
      try {
        const inf = await FS.getInfoAsync(dest).catch(() => null);
        if (inf?.exists && (!ref.size || Number(inf.size) === Number(ref.size))) { ok = true; summary.alreadyThere++; }
        else {
          const tmp = await ref.open();
          try {
            if (tmp?.uri) {
              await FS.deleteAsync(dest, { idempotent: true }).catch(() => {});
              if (/\/waimp\//.test(tmp.uri)) await FS.moveAsync({ from: tmp.uri, to: dest });
              else await FS.copyAsync({ from: tmp.uri, to: dest });
              ok = true;
            }
          } finally { try { tmp?.cleanup?.(); } catch {} }
        }
      } catch { ok = false; }
      if (ok) {
        const got = { local_path: dest, size: ref.size || 0, mime: _mimeOf(ref.name) };
        if (upload) {
          try {
            const EM = require('../e2ee/e2ee5Media');
            const kind = EM.kindOfAppType(_typeOf(ref.kind), ref.name, got.mime);
            const conv = Number(opts.originConvId) > 0 ? Number(opts.originConvId) : 0;
            const M = await EM.buildMedia(conv, kind, { uri: dest, name: ref.name, mime: got.mime, size: ref.size || 0 }, {});
            if (M && M.url) got.e2ee = M;
          } catch { /* fica só local */ }
        }
        pending.push({ m, got });
        mediaOk++;
        const k = ref.kind;
        if (k === 'image') summary.photos++;
        else if (k === 'video') summary.videos++;
        else if (k === 'voice' || k === 'audio') summary.audios++;
        else if (k === 'sticker') summary.stickers++;
        else summary.docs++;
      } else summary.failed++;
      mediaDone++;
      if (pending.length >= MEDIA_REWRITE_EVERY) await flush();
      emit('media', sent, mediaDone);
    }
    await flush();
  }
  const cancelled = !!signal.cancelled;
  await _writeConversation(buildLocalConversation({ ...baseConv, status: cancelled ? 'partial' : 'done', messageCount: sent, mediaCount: mediaOk, lastRow }), account);
  if (!cancelled) emit('done', sent, mediaTotal);
  _notifyChanged();
  return done(cancelled);
}

function _typeOf(kind) { return kind === 'contact' ? 'file' : (kind || 'file'); }
function _mimeOf(name) { try { return require('./importer').mimeForName(name); } catch { return 'application/octet-stream'; } }

// ── leitura / gestão ──────────────────────────────────────────────────────
const _subs = new Set();
export function subscribeLocalImports(fn) { _subs.add(fn); return () => _subs.delete(fn); }
function _notifyChanged() { _subs.forEach((fn) => { try { fn(); } catch {} }); }

/** Importações locais DESTA conta (mais recentes primeiro). */
export async function listLocalImports() {
  if (Platform.OS === 'web') return [];
  const db = await _handle();
  if (!db) return [];
  const account = _acct();
  if (!account) return [];
  let rows = [];
  try {
    rows = await db.getAllAsync(
      'SELECT raw_json FROM conversations WHERE id <= ? AND id > ? AND account_email = ? ORDER BY last_message_time DESC',
      [-CONV_BASE, -(CONV_BASE + SLOTS), account],
    );
  } catch { rows = []; }
  return rows.map((r) => { try { return JSON.parse(r.raw_json); } catch { return null; } }).filter((c) => c && c.imported);
}

export async function getLocalImport(convId) {
  if (!isLocalImportConvId(convId)) return null;
  const db = await _handle();
  if (!db) return null;
  const account = _acct();
  try {
    const r = await db.getFirstAsync('SELECT raw_json FROM conversations WHERE id = ? AND account_email = ?', [Number(convId), account]);
    return r ? JSON.parse(r.raw_json) : null;
  } catch { return null; }
}

/** Página de mensagens (antiga → nova). beforeId = id da mais antiga já carregada. */
export async function getLocalMessages(convId, limit = 80, beforeId = null) {
  if (!isLocalImportConvId(convId)) return [];
  try { return await _db().dbGetMessages(Number(convId), limit, beforeId); } catch { return []; }
}

/** Apaga a cópia importada deste aparelho (mensagens + registro + arquivos de mídia). */
export async function deleteLocalImport(convId) {
  const slot = slotOfConvId(convId);
  if (slot < 0) return false;
  const account = _acct();
  const cur = await getLocalImport(convId);
  if (!cur) return false;
  await _db().dbRunSerialized('waImportLocalDel', async (db) => {
    await db.runAsync('DELETE FROM messages WHERE conversation_id = ? AND account_email = ?', [Number(convId), account]);
    await db.runAsync('DELETE FROM conversations WHERE id = ? AND account_email = ?', [Number(convId), account]);
  });
  try { const dir = _mediaDir(slot); if (dir) await _fs()?.deleteAsync?.(dir, { idempotent: true }); } catch {}
  _notifyChanged();
  return true;
}
