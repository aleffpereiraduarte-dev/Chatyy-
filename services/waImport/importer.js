// [2026-10-10 wa-import] Orquestra a importação de um export do WhatsApp.
//
//   const prep = await prepareImport(files)      // lê .zip/.txt, faz o parse
//   prep.participants / prep.stats / prep.title   // tela de revisão
//   await runImport(prep, { meName, title, linkEmail }, onProgress, signal)
//
// Ordem: start (cria/reabre a cópia pessoal no servidor) → para cada lote de
// 250 mensagens: sobe a mídia citada no lote (se ainda não subiu) → envia o lote.
// Idempotente no servidor (chave por mensagem + mídia por nome), então
// "continuar depois" = escolher o mesmo arquivo de novo; o progresso salvo
// pula os lotes já confirmados.
import { Platform } from 'react-native';
import { parseWhatsAppChat, decodeChatBytes, looksLikeWhatsAppChat, localTsToIso, mediaKindFromName, titleFromFileName, guessMe } from './parser';
import { isZip, listZipEntries, readZipEntryBytes, extractZipEntry } from './zip';
import { openSource, readAllText, createTempSink } from './source';
import { sha256Hex, utf8Bytes } from './sha256';
import { waImportStart, waImportMedia, waImportBatch, waImportFinish } from './api';
import { rememberImport } from './registry';

const BATCH = 250;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

function _base(n) { return String(n || '').replace(/^.*[\\/]/, ''); }
function _ext(n) { return _base(n).split('.').pop().toLowerCase(); }

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', m4v: 'video/mp4', webm: 'video/webm',
  opus: 'audio/ogg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', amr: 'audio/amr', wav: 'audio/wav',
  pdf: 'application/pdf', vcf: 'text/vcard', txt: 'text/plain',
};
export function mimeForName(n) { return MIME[_ext(n)] || 'application/octet-stream'; }

/** É um arquivo de export do WhatsApp (pelo nome)? Usado pelo compartilhar. */
export function isWhatsAppExportName(name) {
  const b = _base(name).toLowerCase();
  if (b === '_chat.txt') return true;
  if (!/\.(zip|txt)$/.test(b)) return false;
  return /whats\s?app/.test(b) || !!titleFromFileName(name);
}

/**
 * files: [{ uri, name, mime, size, file? }]
 * → { title, participants, stats, messages, media: Map<lowerName, {name,size,open()}>, platform, close() }
 */
// Texto compartilhado (Android manda o export sem mídia como texto) → importador.
let _sharedText = '';
export function stashSharedText(txt) { _sharedText = String(txt || ''); }
export function takeSharedText() { const x = _sharedText; _sharedText = ''; return x; }

export async function prepareImport(files, { localeHint = '', myName = '' } = {}) {
  const textItem = (files || []).find((f) => f && typeof f.text === 'string' && f.text);
  const list = (files || []).filter((f) => f && (f.uri || f.file));
  if (!list.length && !textItem) throw new Error('no_file');
  const media = new Map();
  const closers = [];
  let chatBytes = null;
  let chatName = '';
  let zipName = '';

  for (const item of list) {
    const name = item.name || _base(item.uri) || 'file';
    const src = await openSource(item);
    if (await isZip(src)) {
      zipName = zipName || name;
      closers.push(() => src.close());
      const entries = await listZipEntries(src);
      const txts = entries.filter((e) => !e.isDir && /\.txt$/i.test(e.name) && !/__macosx/i.test(e.name));
      const pick = txts.find((e) => _base(e.name).toLowerCase() === '_chat.txt') || txts.find((e) => /whats\s?app/i.test(e.name)) || (txts.length === 1 ? txts[0] : null);
      if (pick && !chatBytes) { chatBytes = await readZipEntryBytes(src, pick, 128 * 1024 * 1024); chatName = name; }
      for (const e of entries) {
        if (e.isDir || e === pick || /__macosx/i.test(e.name) || _base(e.name).startsWith('.')) continue;
        const bn = _base(e.name);
        media.set(bn.toLowerCase(), {
          name: bn, size: e.size,
          open: async () => {
            const sink = createTempSink(bn, mimeForName(bn));
            await extractZipEntry(src, e, (c) => sink.write(c));
            return sink.finish();
          },
        });
      }
    } else {
      src.close();
      const isTxt = /\.txt$/i.test(name) || /^text\//.test(item.mime || '');
      if (isTxt && !chatBytes) {
        const bytes = await readAllText(item);
        const txt = decodeChatBytes(bytes);
        if (looksLikeWhatsAppChat(txt)) { chatBytes = bytes; chatName = name; continue; }
      }
      media.set(name.toLowerCase(), {
        name, size: Number(item.size) || 0,
        open: async () => (Platform.OS === 'web'
          ? { file: item.file || (await fetch(item.uri).then((r) => r.blob())), cleanup: () => {} }
          : { uri: item.uri, cleanup: () => {} }),
      });
    }
  }
  if (!chatBytes && textItem) {
    chatBytes = utf8Bytes(textItem.text);
    chatName = textItem.name || '';
  }
  if (!chatBytes) {
    closers.forEach((c) => { try { c(); } catch {} });
    throw new Error('no_chat_txt');
  }
  const text = decodeChatBytes(chatBytes);
  const fileTitle = titleFromFileName(zipName || chatName) || titleFromFileName(chatName);
  const parsed = parseWhatsAppChat(text, { fileName: zipName || chatName, localeHint, mediaNames: [...media.values()].map((m) => m.name), title: fileTitle });
  if (!parsed.messages.length) {
    closers.forEach((c) => { try { c(); } catch {} });
    throw new Error('no_messages');
  }
  const title = fileTitle || parsed.participants.map((p) => p.name).slice(0, 3).join(', ') || 'WhatsApp';
  const referenced = parsed.messages.filter((m) => m.kind === 'media' && m.attachment);
  const mediaPresent = referenced.filter((m) => media.has(m.attachment.toLowerCase())).length;
  return {
    title,
    participants: parsed.participants,
    guessedMe: guessMe(parsed.participants, { myName, title: fileTitle }),
    platform: parsed.platform,
    dateOrder: parsed.dateOrder,
    stats: { ...parsed.stats, mediaPresent, mediaMissing: referenced.length - mediaPresent },
    messages: parsed.messages,
    media,
    close: () => closers.forEach((c) => { try { c(); } catch {} }),
  };
}

export function chatKeyFor(prep, title) {
  const names = prep.participants.map((p) => p.name).sort().join('|');
  return sha256Hex(`wa|${String(title || '').trim().toLowerCase()}|${names}`);
}

function _progressKey(email, chatKey) { return `waimp:prog:v1:${email}:${chatKey}`; }
function _storage() { try { return require('@react-native-async-storage/async-storage').default; } catch { return null; } }

/**
 * opts: { meName, title, linkEmail, email(conta, p/ chave do progresso) }
 * onProgress({ phase, sent, total, mediaDone, mediaTotal, skippedMedia })
 * signal: { cancelled: bool }
 * → { importId, conversationId, inserted, skippedMedia, failedMedia }
 */
export async function runImport(prep, opts, onProgress, signal = {}) {
  const title = (opts.title || prep.title || 'WhatsApp').slice(0, 80);
  const chatKey = chatKeyFor(prep, title);
  const msgs = prep.messages;
  const mediaMsgs = msgs.filter((m) => m.kind === 'media' && m.attachment && prep.media.has(m.attachment.toLowerCase()));
  const st = await waImportStart({
    chat_key: chatKey, title, platform: prep.platform,
    participants: prep.participants.map((p) => ({ name: p.name, is_me: p.name === opts.meName })),
    link_email: opts.linkEmail || '',
    total_messages: msgs.length, total_media: mediaMsgs.length,
    first_at: localTsToIso(prep.stats.first), last_at: localTsToIso(prep.stats.last),
  });
  if (!st?.success) throw Object.assign(new Error(st?.message || 'start_failed'), { status: st?.status });
  const importId = st.data.import.id;
  const conversationId = st.data.conversation_id;
  try { rememberImport(st.data.import); } catch {}
  const uploaded = {};
  for (const [name, v] of Object.entries(st.data.media || {})) uploaded[name.toLowerCase()] = v.id;

  const storage = _storage();
  const pk = _progressKey(String(opts.email || '').toLowerCase(), chatKey);
  let startAt = 0;
  try {
    const raw = await storage?.getItem(pk);
    const j = raw ? JSON.parse(raw) : null;
    if (j && j.importId === importId && j.total === msgs.length && j.sent > 0 && j.sent <= msgs.length) startAt = j.sent;
  } catch {}

  let mediaDone = Object.keys(uploaded).length;
  const mediaTotal = mediaMsgs.length;
  let inserted = 0;
  let skippedMedia = 0;
  let failedMedia = 0;
  const report = (phase, sent) => { try { onProgress?.({ phase, sent, total: msgs.length, mediaDone, mediaTotal, skippedMedia, failedMedia }); } catch {} };
  report('messages', startAt);

  for (let i = startAt; i < msgs.length; i += BATCH) {
    if (signal.cancelled) return { importId, conversationId, inserted, skippedMedia, failedMedia, cancelled: true, sent: i };
    const slice = msgs.slice(i, i + BATCH);
    // 1) mídia deste lote
    for (const m of slice) {
      if (m.kind !== 'media' || !m.attachment) continue;
      const key = m.attachment.toLowerCase();
      if (uploaded[key] || !prep.media.has(key)) continue;
      if (signal.cancelled) break;
      const ref = prep.media.get(key);
      if (ref.size && ref.size > MAX_MEDIA_BYTES) { skippedMedia++; uploaded[key] = 0; continue; }
      let tmp = null;
      try {
        report('media', i);
        tmp = await ref.open();
        let r = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          r = await waImportMedia(importId, ref.name, Platform.OS === 'web' ? tmp.file : { uri: tmp.uri }, mimeForName(ref.name));
          if (r?.success || r?.status === 413 || r?.status === 400 || r?.status === 401) break;
          await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        }
        if (r?.success) { uploaded[key] = r.data.id; mediaDone++; }
        else if (r?.status === 413) { skippedMedia++; uploaded[key] = 0; }
        else if (r?.status === 401) throw Object.assign(new Error('auth'), { status: 401 });
        else { failedMedia++; }
      } catch (e) {
        if (e?.status === 401) throw e;
        failedMedia++;
      } finally {
        try { tmp?.cleanup?.(); } catch {}
      }
    }
    // 2) lote de mensagens
    const payload = slice.map((m) => {
      const o = { k: m.key, ts: localTsToIso(m.tsLocal), kind: m.kind, text: m.text || '' };
      if (m.sender) { o.sn = m.sender; if (m.sender === opts.meName) o.me = true; }
      if (m.edited) o.edited = true;
      if (m.kind === 'media') {
        o.name = m.attachment || '';
        const id = m.attachment ? uploaded[m.attachment.toLowerCase()] : 0;
        if (id) o.media = id;
        if (!id && !o.text) o.text = m.attachment || '';
        if (m.attachment && !id) o.kind_hint = mediaKindFromName(m.attachment);
      }
      return o;
    }).filter((o) => o.ts);
    let r = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      r = await waImportBatch(importId, payload);
      if (r?.success || r?.status === 400 || r?.status === 401 || r?.status === 404) break;
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
    if (!r?.success) throw Object.assign(new Error(r?.message || 'batch_failed'), { status: r?.status, sent: i });
    inserted += Number(r.data?.inserted) || 0;
    const sent = Math.min(msgs.length, i + BATCH);
    try { await storage?.setItem(pk, JSON.stringify({ importId, total: msgs.length, sent, at: Date.now() })); } catch {}
    report('messages', sent);
  }
  const fin = await waImportFinish(importId);
  try { if (fin?.success) rememberImport(fin.data.import); } catch {}
  try { await storage?.removeItem(pk); } catch {}
  report('done', msgs.length);
  return { importId, conversationId, inserted, skippedMedia, failedMedia };
}
