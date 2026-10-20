// [2026-10-10 wa-import] Orquestra a importação de um export do WhatsApp.
//
//   const prep = await prepareImport(files, { onProgress })   // lê .zip/.txt, faz o parse EM FATIAS
//   prep.participants / prep.stats / prep.title / prep.format  // tela de revisão
//   await runImport(prep, opts, onProgress, signal)            // normalmente via services/waImport/job
//
// [wa-import-v2 2026-10-13] RÁPIDO / SEGURO / INTELIGENTE
//   • Parse em fatias (cede o event loop a cada ~12 ms) e inflate do zip com yield → UI não trava.
//   • Fase A: TODAS as mensagens primeiro, em lotes de até 500 (≤ ~900 KB), em ordem cronológica
//     (o histórico aparece em segundos e os ids ficam em ordem). Mídia já enviada vai junto.
//   • Fase B: mídia em paralelo (3), com retomada; cada grupo enviado "anexa" a mídia ao MESMO
//     registro (servidor: ON CONFLICT DO UPDATE → mesmo id, ordem preservada).
//   • Pausar / retomar / cancelar (signal.paused / signal.cancelled); progresso + tempo estimado.
//   • Idempotente: chave sha256 por mensagem (client_message_id 'wai:<conversa>:<chave>');
//     reimportar o mesmo export (ou um mais novo) não duplica.
//   • Segurança: tamanho máximo, zip bomb / zip slip (zip.js), só tipos de mídia conhecidos
//     (executável/HTML/SVG nunca sobem), nomes saneados, texto nunca é interpretado como HTML.
//   • Modo 'direct': continuação na conversa 1:1 real com a pessoa (servidor verifica).
import { Platform } from 'react-native';
import { parseWhatsAppChatAsync, decodeChatBytes, looksLikeWhatsAppChat, localTsToIso, mediaKindFromName, titleFromFileName, guessMe, describeFormat } from './parser';
import { isZip, listZipEntries, readZipEntryBytes, extractZipEntry } from './zip';
import { openSource, readAllText, createTempSink } from './source';
import { sha256Hex, utf8Bytes } from './sha256';
import { waImportStart, waImportMedia, waImportBatch, waImportFinish } from './api';
import { rememberImport } from './registry';

const BATCH = 500;                     // = WA_IMPORT_MAX_BATCH do servidor
const BATCH_MAX_BYTES = 900 * 1024;    // JSON por chamada
const MEDIA_CONCURRENCY = 3;
// [wa-import-fase2 2026-10-13] velocidade: paralelismo adaptativo (1..6 conforme a rede responde), foto JPEG
// grande (> 2 MB) reduzida p/ ~1600 px JPEG 80 antes de subir (só no aparelho; .opus/áudio/vídeo intactos),
// vídeos grandes (> 25 MB) vão para o FIM da fila (o resto aparece antes).
const MEDIA_CONC_MIN = 1;
const MEDIA_CONC_MAX = 6;
const PHOTO_SHRINK_BYTES = 2 * 1024 * 1024;
const PHOTO_MAX_SIDE = 1600;
const VIDEO_LATE_BYTES = 25 * 1024 * 1024;

function _fsLegacy() { try { return require('expo-file-system/legacy'); } catch { try { return require('expo-file-system'); } catch { return null; } } }
function _imageSize(uri) {
  return new Promise((resolve) => {
    try { require('react-native').Image.getSize(uri, (w, h) => resolve({ w, h }), () => resolve(null)); } catch { resolve(null); }
  });
}
/** Foto JPEG grande → cópia ~1600 px JPEG 80 (mesmo nome no servidor). Falhou → original. */
async function _maybeShrinkPhoto(ref, tmp) {
  try {
    if (Platform.OS === 'web' || !tmp?.uri || ref.kind !== 'image') return null;
    if (!['jpg', 'jpeg'].includes(_ext(ref.name)) || !(ref.size > PHOTO_SHRINK_BYTES)) return null;
    const dim = await _imageSize(tmp.uri);
    if (!dim || !dim.w || !dim.h) return null;
    const big = Math.max(dim.w, dim.h);
    const IM = require('expo-image-manipulator');
    const act = big > PHOTO_MAX_SIDE ? [{ resize: dim.w >= dim.h ? { width: PHOTO_MAX_SIDE } : { height: PHOTO_MAX_SIDE } }] : [];
    const out = await IM.manipulateAsync(tmp.uri, act, { compress: 0.8, format: IM.SaveFormat.JPEG });
    if (!out?.uri) return null;
    return { uri: out.uri, cleanup: () => { try { _fsLegacy()?.deleteAsync?.(out.uri, { idempotent: true })?.catch?.(() => {}); } catch {} } };
  } catch { return null; }
}
const ATTACH_EVERY = 60;               // mídias enviadas → 1 chamada "anexar"
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;     // por arquivo (= servidor)
export const MAX_INPUT_BYTES = 4 * 1024 * 1024 * 1024; // .zip escolhido
export const MAX_CHAT_TXT = 64 * 1024 * 1024;          // _chat.txt descomprimido

function _base(n) { return String(n || '').replace(/^.*[\\/]/, ''); }
function _ext(n) { return _base(n).split('.').pop().toLowerCase(); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  opus: 'audio/ogg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', mp3: 'audio/mpeg', amr: 'audio/amr', wav: 'audio/wav',
  pdf: 'application/pdf', vcf: 'text/vcard', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export function mimeForName(n) { return MIME[_ext(n)] || 'application/octet-stream'; }
/** Só sobe o que o WhatsApp exporta de verdade. Executável/HTML/SVG/etc. → bloqueado. */
export function isAllowedMediaName(n) { return Object.prototype.hasOwnProperty.call(MIME, _ext(n)); }
function _safeName(n) {
  return _base(n).replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').slice(0, 180);
}

/** É um arquivo de export do WhatsApp (pelo nome)? Usado pelo compartilhar. */
export function isWhatsAppExportName(name) {
  const b = _base(name).toLowerCase();
  if (b === '_chat.txt') return true;
  if (!/\.(zip|txt)$/.test(b)) return false;
  return /whats\s?app/.test(b) || !!titleFromFileName(name);
}

// Texto compartilhado (Android manda o export sem mídia como texto) → importador.
let _sharedText = '';
export function stashSharedText(txt) { _sharedText = String(txt || ''); }
export function takeSharedText() { const x = _sharedText; _sharedText = ''; return x; }

// [2026-10-20 wa-export-sniff] Export do WhatsApp com nome genérico (iOS manda
// "Chat.zip", o .txt renomeado, ou só o conteúdo): olha DENTRO do arquivo.
//   .zip → tem _chat.txt / "WhatsApp Chat*.txt" / "Conversa do WhatsApp*.txt"
//   .txt (ou text/*) → ≥ 2 cabeçalhos de mensagem nas primeiras linhas
// Barato: só o diretório central do zip (≤ 64 KB) e 16 KB do .txt; máx. 10 arquivos.
const _SNIFF_TXT_RE = /^(?:_chat|.*whats\s?app.*)\.txt$/i;
export function isSniffCandidate(f) {
  const n = String(f?.name || f?.uri || '').toLowerCase();
  const m = String(f?.mime || '').toLowerCase();
  return /\.(zip|txt)$/.test(n) || /zip/.test(m) || m.startsWith('text/plain') || !/\.[a-z0-9]{1,5}$/.test(n.replace(/^.*[\\/]/, ''));
}
export async function sniffWhatsAppExport(files, { timeoutMs = 2500 } = {}) {
  const list = (files || []).filter((f) => f && (f.uri || f.file) && isSniffCandidate(f)).slice(0, 10);
  if (!list.length) return false;
  const work = (async () => {
    for (const item of list) {
      let src = null;
      try {
        src = await openSource(item);
        if (!src || !src.size) continue;
        if (await isZip(src)) {
          const entries = await listZipEntries(src);
          const txts = entries.filter((e) => !e.isDir && /\.txt$/i.test(e.name || '') && !/__macosx/i.test(e.name || ''));
          if (txts.some((e) => _SNIFF_TXT_RE.test(_base(e.name)) || !!titleFromFileName(_base(e.name)))) return true;
          continue;
        }
        const head = await src.read(0, Math.min(src.size, 16384));
        if (looksLikeWhatsAppChat(decodeChatBytes(head))) return true;
      } catch {} finally { try { src?.close?.(); } catch {} }
    }
    return false;
  })();
  return Promise.race([work, new Promise((res) => setTimeout(() => res(false), timeoutMs))]);
}

function _err(code, extra) { return Object.assign(new Error(code), extra || {}); }

/**
 * files: [{ uri, name, mime, size, file? }]
 * opts: { localeHint, myName, myPhone, peerName, peerPhone, onProgress(0..1), signal }
 * → { title, fileTitle, participants, guessedMe, platform, dateOrder, format, stats, messages,
 *     media: Map<lowerName, {name,size,kind,open()}>, close() }
 */
export async function prepareImport(files, { localeHint = '', myName = '', myPhone = '', peerName = '', peerPhone = '', onProgress, signal } = {}) {
  const textItem = (files || []).find((f) => f && typeof f.text === 'string' && f.text);
  const list = (files || []).filter((f) => f && (f.uri || f.file));
  if (!list.length && !textItem) throw new Error('no_file');
  const media = new Map();
  const closers = [];
  let chatBytes = null;
  let chatName = '';
  let zipName = '';
  let blocked = 0;
  const report = (x) => { try { onProgress?.(Math.max(0, Math.min(1, x))); } catch {} };
  report(0.02);

  try {
    for (const item of list) {
      const name = _safeName(item.name || _base(item.uri) || 'file') || 'file';
      const src = await openSource(item);
      if (src.size > MAX_INPUT_BYTES) { src.close(); throw _err('too_big', { max: MAX_INPUT_BYTES }); }
      if (await isZip(src)) {
        zipName = zipName || name;
        closers.push(() => src.close());
        const entries = await listZipEntries(src);
        const txts = entries.filter((e) => !e.isDir && !e.unsafeName && /\.txt$/i.test(e.name) && !/__macosx/i.test(e.name));
        const pick = txts.find((e) => _base(e.name).toLowerCase() === '_chat.txt') || txts.find((e) => /whats\s?app/i.test(e.name)) || (txts.length === 1 ? txts[0] : null);
        if (pick && !chatBytes) { chatBytes = await readZipEntryBytes(src, pick, MAX_CHAT_TXT); chatName = name; }
        for (const e of entries) {
          if (e.isDir || e === pick || /__macosx/i.test(e.name) || _base(e.name).startsWith('.')) continue;
          const bn = _safeName(e.name);
          if (!bn || e.unsafeName || e.bomb || e.encrypted || !isAllowedMediaName(bn)) { blocked++; continue; }
          media.set(bn.toLowerCase(), {
            name: bn, size: e.size, kind: mediaKindFromName(bn),
            open: async () => {
              const sink = createTempSink(bn, mimeForName(bn));
              await extractZipEntry(src, e, (c) => sink.write(c), { maxOut: MAX_MEDIA_BYTES + 1024 });
              return sink.finish();
            },
          });
        }
      } else {
        src.close();
        const isTxt = /\.txt$/i.test(name) || /^text\/plain/.test(item.mime || '') || !/\.[a-z0-9]{1,5}$/i.test(name); // [2026-10-20] sem extensão: confere o conteúdo
        if (isTxt && !chatBytes) {
          if ((Number(item.size) || src.size || 0) > MAX_CHAT_TXT) throw _err('too_big', { max: MAX_CHAT_TXT });
          const bytes = await readAllText(item);
          const txt = decodeChatBytes(bytes);
          if (looksLikeWhatsAppChat(txt)) { chatBytes = bytes; chatName = name; continue; }
        }
        if (!isAllowedMediaName(name)) { blocked++; continue; }
        media.set(name.toLowerCase(), {
          name, size: Number(item.size) || 0, kind: mediaKindFromName(name),
          open: async () => (Platform.OS === 'web'
            ? { file: item.file || (await fetch(item.uri).then((r) => r.blob())), cleanup: () => {} }
            : { uri: item.uri, cleanup: () => {} }),
        });
      }
      if (signal?.cancelled) throw new Error('cancelled');
    }
    if (!chatBytes && textItem) {
      if (textItem.text.length > MAX_CHAT_TXT) throw _err('too_big', { max: MAX_CHAT_TXT });
      chatBytes = utf8Bytes(textItem.text);
      chatName = textItem.name || '';
    }
    if (!chatBytes) throw new Error('no_chat_txt');
    report(0.1);
    const text = decodeChatBytes(chatBytes);
    chatBytes = null;
    const fileTitle = titleFromFileName(zipName || chatName) || titleFromFileName(chatName);
    const parsed = await parseWhatsAppChatAsync(text, {
      fileName: zipName || chatName, localeHint, mediaNames: [...media.values()].map((m) => m.name), title: fileTitle, signal,
    }, (f) => report(0.1 + 0.85 * f));
    if (!parsed.messages.length) throw new Error('no_messages');
    // Ordem cronológica estável (DST/fuso podem inverter 2 linhas; o servidor ordena por id).
    const messages = parsed.messages.slice().sort((a, b) => (a.tsLocal < b.tsLocal ? -1 : a.tsLocal > b.tsLocal ? 1 : a.idx - b.idx));
    const title = fileTitle || parsed.participants.map((p) => p.name).slice(0, 3).join(', ') || 'WhatsApp';
    const referenced = messages.filter((m) => m.kind === 'media' && m.attachment);
    const present = referenced.filter((m) => media.has(m.attachment.toLowerCase()));
    const byKind = { image: 0, video: 0, voice: 0, audio: 0, sticker: 0, contact: 0, file: 0 };
    for (const m of present) { const k = media.get(m.attachment.toLowerCase()).kind; byKind[k] = (byKind[k] || 0) + 1; }
    report(1);
    return {
      title,
      fileTitle,
      participants: parsed.participants,
      // [wa-1a1 2026-10-14] grupo de verdade × 1:1 (remetentes falsos de texto colado já desfeitos no parser)
      isGroup: !!parsed.isGroup, groupSignals: parsed.groupSignals || 0, folded: parsed.folded || 0,
      guessedMe: guessMe(parsed.participants, { myName, title: fileTitle, myPhone, peerName, peerPhone }),
      platform: parsed.platform,
      dateOrder: parsed.dateOrder,
      format: describeFormat(parsed),
      stats: { ...parsed.stats, mediaPresent: present.length, mediaMissing: referenced.length - present.length, blocked, byKind },
      messages,
      media,
      close: () => closers.forEach((c) => { try { c(); } catch {} }),
    };
  } catch (e) {
    closers.forEach((c) => { try { c(); } catch {} });
    throw e;
  }
}

export function chatKeyFor(prep, title) {
  const names = prep.participants.map((p) => p.name).sort().join('|');
  return sha256Hex(`wa|${String(title || '').trim().toLowerCase()}|${names}`);
}

function _progressKey(email, chatKey) { return `waimp:prog:v2:${email}:${chatKey}`; }
function _storage() { try { return require('@react-native-async-storage/async-storage').default; } catch { return null; } }

async function _waitIfPaused(signal) {
  while (signal.paused && !signal.cancelled) await sleep(400);
}

/** Chamada com retentativas: rede/5xx → backoff; 429 → respeita retry_after. */
async function _withRetry(fn, { tries = 5, signal } = {}) {
  let r = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (signal?.cancelled) return r;
    r = await fn();
    if (r?.success) return r;
    const st = Number(r?.status) || 0;
    if (st === 429) { await sleep(Math.min(300, Number(r?.data?.retry_after) || 30) * 1000); continue; }
    if (st >= 400 && st < 500) return r; // 400/401/403/404/409/413/415: não adianta repetir
    await sleep(Math.min(30000, 1500 * 2 ** attempt));
  }
  return r;
}

function _msgPayload(m, opts, uploaded) {
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
}

/** Fatia por nº de mensagens E por bytes de JSON. */
function* _chunks(payloads) {
  let cur = []; let bytes = 0;
  for (const p of payloads) {
    const b = 64 + (p.text ? p.text.length * 2 : 0) + (p.sn ? p.sn.length * 2 : 0);
    if (cur.length && (cur.length >= BATCH || bytes + b > BATCH_MAX_BYTES)) { yield cur; cur = []; bytes = 0; }
    cur.push(p); bytes += b;
  }
  if (cur.length) yield cur;
}

/**
 * opts: { meName, title, linkEmail, email (conta), mode: 'copy'|'direct', targetConversationId,
 *         peerHintName, fileTitle, confirmMismatch, preferImportId, peerPhoneHashes }
 * onProgress({ phase, sent, total, mediaDone, mediaTotal, frac, etaSec })
 * signal: { cancelled, paused }
 * → { importId, conversationId, mode, verified, summary, cancelled? }
 * Erros do servidor no start viram Error(reason) com .reason/.data (unverified, has_messages, …).
 */
export async function runImport(prep, opts, onProgress, signal = {}) {
  const title = (opts.title || prep.title || 'WhatsApp').slice(0, 80);
  const chatKey = chatKeyFor(prep, title);
  const direct = opts.mode === 'direct';
  const msgs = prep.messages.filter((m) => m.tsLocal && (!direct || (m.kind !== 'system' && m.kind !== 'deleted')));
  const mediaMsgs = msgs.filter((m) => m.kind === 'media' && m.attachment && prep.media.has(m.attachment.toLowerCase()));
  const st = await _withRetry(() => waImportStart({
    chat_key: chatKey, title, platform: prep.platform,
    participants: prep.participants.map((p) => ({ name: p.name, is_me: p.name === opts.meName })),
    link_email: opts.linkEmail || '',
    total_messages: msgs.length, total_media: mediaMsgs.length,
    first_at: localTsToIso(prep.stats.first), last_at: localTsToIso(prep.stats.last),
    mode: direct ? 'direct' : 'copy',
    target_conversation_id: direct ? Number(opts.targetConversationId) || 0 : undefined,
    peer_hint_name: opts.peerHintName || '', file_title: opts.fileTitle || prep.fileTitle || '',
    confirm_mismatch: opts.confirmMismatch ? 1 : 0,
    // [wa-phone 2026-10-14] só hashes sha256(E.164) do contato da agenda/export; servidor confere SÓ contra a pessoa escolhida
    peer_phone_hashes: direct && Array.isArray(opts.peerPhoneHashes) && opts.peerPhoneHashes.length ? opts.peerPhoneHashes.slice(0, 16) : undefined,
    prefer_import_id: opts.preferImportId || undefined,
    // [import-ordem 2026-10-13] este app ordena por data → servidor novo aceita importar
    // na conversa que JÁ tem mensagens (intercala pela data). Servidor velho ignora → 409 has_messages.
    interleave: direct ? 1 : undefined,
  }), { tries: 3, signal });
  if (!st?.success) {
    const reason = st?.data?.reason || st?.message || 'start_failed';
    throw _err(reason, { status: st?.status, reason, data: st?.data || {} });
  }
  const importId = st.data.import.id;
  const conversationId = st.data.conversation_id;
  const mode = st.data.mode || (direct ? 'direct' : 'copy');
  const verified = st.data.verified || '';
  try { rememberImport(st.data.import); } catch {}
  const uploaded = {};
  for (const [name, v] of Object.entries(st.data.media || {})) uploaded[name.toLowerCase()] = v.id;

  const storage = _storage();
  const pk = _progressKey(String(opts.email || '').toLowerCase(), `${importId}:${chatKey}`);
  let startAt = 0;
  try {
    const raw = await storage?.getItem(pk);
    const j = raw ? JSON.parse(raw) : null;
    if (j && j.importId === importId && j.total === msgs.length && j.sent > 0 && j.sent <= msgs.length) startAt = j.sent;
  } catch {}

  const mediaTotal = mediaMsgs.length;
  let mediaDone = mediaMsgs.filter((m) => uploaded[m.attachment.toLowerCase()]).length;
  const sum = { inserted: 0, dup: 0, attached: 0, unmapped: 0, failed: 0, tooBig: 0, blocked: prep.stats.blocked || 0 };
  const t0 = Date.now();
  const W = 12; // 1 mídia ≈ 12 mensagens de trabalho
  let sent = startAt;
  const startFrac = (startAt + mediaDone * W) / Math.max(1, msgs.length + mediaTotal * W);
  const report = (phase) => {
    const frac = Math.min(1, (sent + mediaDone * W) / Math.max(1, msgs.length + mediaTotal * W));
    const el = (Date.now() - t0) / 1000;
    const done = frac - startFrac;
    const etaSec = done > 0.01 && el > 3 ? Math.round((el / done) * (1 - frac)) : null;
    try { onProgress?.({ phase, sent, total: msgs.length, mediaDone, mediaTotal, frac, etaSec, paused: !!signal.paused, importId, conversationId, mode, verified }); } catch {}
  };
  const cancelled = () => ({ importId, conversationId, mode, verified, cancelled: true, summary: _summary(prep, sum, uploaded, mediaMsgs) });
  report('messages');

  // ── Fase A: mensagens (rápido, cronológico) ────────────────────────────
  const payloads = msgs.slice(startAt).map((m) => _msgPayload(m, opts, uploaded)).filter((o) => o.ts);
  for (const chunk of _chunks(payloads)) {
    await _waitIfPaused(signal);
    if (signal.cancelled) return cancelled();
    const r = await _withRetry(() => waImportBatch(importId, chunk), { signal });
    if (signal.cancelled) return cancelled();
    if (!r?.success) throw _err(r?.data?.reason || r?.message || 'batch_failed', { status: r?.status, reason: r?.data?.reason, sent });
    sum.inserted += Number(r.data?.inserted) || 0;
    sum.dup += Number(r.data?.skipped) || 0;
    sum.unmapped += Number(r.data?.unmapped) || 0;
    sent += chunk.length;
    try { await storage?.setItem(pk, JSON.stringify({ importId, total: msgs.length, sent, at: Date.now() })); } catch {}
    report('messages');
  }
  sent = msgs.length;

  // ── Fase B: mídia em paralelo (3) + anexar ao mesmo registro ───────────
  const pending = [];
  const seen = new Set();
  for (const m of mediaMsgs) {
    const key = m.attachment.toLowerCase();
    if (uploaded[key] || seen.has(key)) continue;
    seen.add(key);
    pending.push(key);
  }
  // [wa-import-fase2] vídeos grandes por último (ordem estável no resto).
  const _late = (k) => { const r = prep.media.get(k); return !!r && r.kind === 'video' && (r.size || 0) > VIDEO_LATE_BYTES; };
  pending.sort((a, b) => Number(_late(a)) - Number(_late(b)));
  // Retomada: mídia que já subiu numa tentativa anterior pode não ter sido anexada
  // (app fechou entre o upload e o "anexar") → reanexa (no servidor é no-op se já está).
  const toAttach = startAt > 0 ? Object.keys(uploaded).filter((k) => uploaded[k]) : [];
  const flushAttach = async (force) => {
    if (!toAttach.length || (!force && toAttach.length < ATTACH_EVERY)) return;
    const keys = new Set(toAttach.splice(0));
    const pl = mediaMsgs.filter((m) => keys.has(m.attachment.toLowerCase())).map((m) => _msgPayload(m, opts, uploaded)).filter((o) => o.ts && o.media);
    for (const chunk of _chunks(pl)) {
      const r = await _withRetry(() => waImportBatch(importId, chunk), { signal });
      if (r?.success) sum.attached += Number(r.data?.attached) || 0;
    }
  };
  let next = 0;
  // [wa-import-fase2] paralelismo adaptativo: começa em 3; upload rápido (< 2,5 s) sobe até 6,
  // falha/lento (> 12 s) desce até 1. Cada worker só pega item novo se couber no alvo atual.
  let target = MEDIA_CONCURRENCY; let active = 0;
  const _tune = (ok, ms) => {
    if (!ok || ms > 12000) target = Math.max(MEDIA_CONC_MIN, target - 1);
    else if (ms < 2500) target = Math.min(MEDIA_CONC_MAX, target + 1);
  };
  const worker = async (slot) => {
    while (next < pending.length) {
      await _waitIfPaused(signal);
      if (signal.cancelled) return;
      if (slot >= target) { await sleep(400); continue; }
      const key = pending[next++];
      const ref = prep.media.get(key);
      if (!ref) continue;
      if (ref.size && ref.size > MAX_MEDIA_BYTES) { sum.tooBig++; uploaded[key] = 0; continue; }
      let tmp = null; let small = null; const _t = Date.now(); let _ok = false;
      active++;
      try {
        tmp = await ref.open();
        small = await _maybeShrinkPhoto(ref, tmp);
        const up = small ? { uri: small.uri } : (Platform.OS === 'web' ? tmp.file : { uri: tmp.uri });
        const r = await _withRetry(() => waImportMedia(importId, ref.name, up, mimeForName(ref.name)), { tries: 4, signal });
        _ok = !!r?.success;
        if (r?.success) { uploaded[key] = r.data.id; mediaDone++; toAttach.push(key); }
        else if (r?.status === 413) { sum.tooBig++; }
        else if (r?.status === 415) { sum.blocked++; }
        else if (r?.status === 401) { throw _err('auth', { status: 401 }); }
        else { sum.failed++; }
      } catch (e) {
        if (e?.status === 401) throw e;
        sum.failed++; // ex.: zip_bomb / arquivo corrompido — segue com o resto
      } finally {
        active--;
        _tune(_ok, Date.now() - _t);
        try { small?.cleanup?.(); } catch {}
        try { tmp?.cleanup?.(); } catch {}
      }
      report('media');
      await flushAttach(false);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MEDIA_CONC_MAX, pending.length) }, (_, i) => worker(i)));
  await flushAttach(true);
  if (signal.cancelled) return cancelled();

  const fin = await _withRetry(() => waImportFinish(importId), { tries: 3, signal });
  try { if (fin?.success) rememberImport(fin.data.import); } catch {}
  try { await storage?.removeItem(pk); } catch {}
  report('done');
  return { importId, conversationId, mode, verified, summary: _summary(prep, sum, uploaded, mediaMsgs) };
}

function _summary(prep, sum, uploaded, mediaMsgs) {
  const kinds = { image: 0, video: 0, voice: 0, audio: 0, sticker: 0, contact: 0, file: 0 };
  const seen = new Set();
  for (const m of mediaMsgs) {
    const k = m.attachment.toLowerCase();
    if (seen.has(k) || !uploaded[k]) continue;
    seen.add(k);
    const kind = prep.media.get(k)?.kind || 'file';
    kinds[kind] = (kinds[kind] || 0) + 1;
  }
  return {
    messages: sum.inserted, alreadyThere: sum.dup, unmapped: sum.unmapped,
    photos: kinds.image, videos: kinds.video, audios: kinds.voice + kinds.audio, stickers: kinds.sticker,
    docs: kinds.file + kinds.contact,
    missing: (prep.stats.mediaMissing || 0) + (prep.stats.mediaOmitted || 0),
    failed: sum.failed + sum.tooBig, blocked: sum.blocked,
  };
}
