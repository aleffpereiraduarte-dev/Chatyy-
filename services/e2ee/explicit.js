// [e2ee5 WP-17 2026-10-21] Recursos EXPLÍCITOS em conversa E2EE (DECISÃO 2 do founder):
// Bia / tradução / transcrição / resumo / denúncia / exportar — só por toque do usuário, com o aviso
// "isto sai da criptografia" (WP-15) e mandando ao servidor SÓ o trecho escolhido, com
// `no_store: true` (servidor WP-16 não guarda cache nem loga conteúdo; API em
// /root/e2ee-2026-10-21/wp16/API.md). Transcrição e tradução preferem o aparelho.
// Exportar = gerado no aparelho a partir do texto já decifrado aqui.
//
// Flag: tudo só vale com globalThis.__chatyy_e2ee5 === true E a conversa com e2ee_mode=1
// (isE2eeConv). Fora disso quem chama segue o caminho de hoje, byte a byte.
// Nunca loga conteúdo (só códigos e tamanhos, e só com __chatyy_e2ee5_debug).
import { Platform, Alert } from 'react-native';

function _e5() { try { return require('./e2ee5'); } catch (_) { return null; } }
function _api() { return require('../api'); }
function _g() { return typeof globalThis !== 'undefined' ? globalThis : global; }
function _log(what, kv) {
  try { if (_g().__chatyy_e2ee5_debug === true) console.warn('[e2ee5x] ' + what + ' ' + (kv ? JSON.stringify(kv) : '')); } catch (_) {}
}
function _tx(t, key, fb) {
  try { const v = typeof t === 'function' ? t(key) : null; return v && v !== key ? v : fb; } catch (_) { return fb; }
}
function _err(code, msg) { const e = new Error(msg || code); e.code = code; return e; }

export const REPORT_MAX = 10;
const SUM_MAX_ITEMS = 300;
const SUM_MAX_CHARS = 24000;
const ASK_MAX_ITEMS = 100;
const ASK_MAX_CHARS = 16000;
const EVIDENCE_TEXT_MAX = 4000;

/** Caminho E2EE v5 ligado neste app (flag OTA). */
export function isOn() { const m = _e5(); return !!(m && m.isOn()); }

/** Conversa cifrada (e2ee_mode=1) — ou a linha é envelope v5. */
export function isE2eeConv(cid, msg) {
  const m = _e5();
  if (!m || !m.isOn()) return false;
  try { if (cid != null && cid !== '' && m.isConvE2eeSync(cid)) return true; } catch (_) {}
  try { if (msg && typeof msg._e2eRaw === 'string' && m.isV5Family(msg._e2eRaw)) return true; } catch (_) {}
  return false;
}

/** Texto que o usuário VÊ na bolha (decifrado neste aparelho) — '' se ainda não decifrou. */
export function plainOf(msg) {
  if (!msg) return '';
  const c = msg.content;
  if (msg._e2e) {
    if (msg._e5State || msg._e2eFailed) return '';
    return typeof c === 'string' ? c : '';
  }
  if (typeof c !== 'string') return '';
  const s = c.trim();
  if (s.startsWith('{"e2e"') || s.startsWith('{"sys"')) return ''; // nunca envelope/sistema cru
  return c;
}

function _isMine(msg, me) {
  const a = String((msg && msg.sender_email) || '').toLowerCase();
  const b = String(me || '').toLowerCase();
  return !!a && !!b && a === b;
}
function _nameOf(msg, me, t) {
  if (_isMine(msg, me)) return _tx(t, 'chatSum.you', 'Você');
  const n = msg && (msg.sender_name || msg.senderName);
  if (n) return String(n).slice(0, 60);
  const e = String((msg && msg.sender_email) || '');
  return e ? e.split('@')[0].slice(0, 60) : '?';
}
function _locale(t) { return _tx(t, '_locale', 'pt-BR'); }

/** Mensagens de usuário com texto visível, em ordem cronológica. */
export function visibleTextRows(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || m.type === 'system' || m.deleted_at || m.deleted_for_all || m._ai_bot || m._e5Local) continue;
    const txt = plainOf(m) || (typeof m.transcript === 'string' ? m.transcript : '');
    if (!txt || !txt.trim()) continue;
    out.push(m);
  }
  const ts = (m) => Date.parse(m.created_at || '') || (typeof m.id === 'number' ? m.id : 0);
  out.sort((a, b) => ts(a) - ts(b));
  return out;
}

/** Trecho {n,t} dos itens escolhidos (mais recentes primeiro na poda). */
export function excerptOf(messages, me, t, maxItems = ASK_MAX_ITEMS, maxChars = ASK_MAX_CHARS) {
  const rows = visibleTextRows(messages).slice(-maxItems);
  const items = [];
  let total = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    const txt = String(plainOf(m) || m.transcript || '').slice(0, 2000);
    if (total + txt.length > maxChars) break;
    total += txt.length;
    items.unshift({ n: _nameOf(m, me, t), t: txt });
  }
  return items;
}

/**
 * Aviso "isto sai da criptografia" SEMPRE (mesmo com a UX do WP-15 desligada por
 * __chatyy_e2ee5_ui=false, aqui o aviso não pode sumir). 1ª vez por tipo; `always` = sempre.
 */
export async function confirmExit(t, kind, opts = {}) {
  let ex = null;
  try { ex = require('../../components/e2ee/exitEncryption'); } catch (_) {}
  let uiOn = false;
  try { uiOn = require('../../components/e2ee/e2eeUi').isE2eeUiEnabled(); } catch (_) {}
  if (ex && uiOn) return ex.confirmExitEncryption(t, kind, opts);
  // fallback local (mesmos textos e mesma chave de "já avisado")
  let AS = null;
  try { AS = require('@react-native-async-storage/async-storage').default; } catch (_) {}
  const key = `e2ee5_exit_ack_${kind}`;
  if (!opts.always && AS) { try { if ((await AS.getItem(key)) === '1') return true; } catch (_) {} }
  const title = _tx(t, 'e2ee5.exit.title', 'Isto sai da criptografia');
  const msg = ex ? ex.exitEncryptionText(t, kind) : _tx(t, 'e2ee5.exit.' + kind, 'Este conteúdo sai da criptografia de ponta a ponta e é enviado ao Chatyy. Ele não fica salvo.');
  const ok = await new Promise((resolve) => {
    if (Platform.OS === 'web') { let r = false; try { r = window.confirm(`${title}\n\n${msg}`); } catch (_) {} resolve(!!r); return; }
    Alert.alert(title, msg, [
      { text: _tx(t, 'e2ee5.common.cancel', 'Cancelar'), style: 'cancel', onPress: () => resolve(false) },
      { text: _tx(t, 'e2ee5.exit.continue', 'Continuar'), onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
  if (ok && !opts.always && AS) { try { await AS.setItem(key, '1'); } catch (_) {} }
  return ok;
}

async function _call(action, cid, params) {
  const api = _api();
  const r = await api.apiCall(action, { ...params, conversation_id: Number(cid) || cid, no_store: true }, 'POST');
  if (r && r.success) return r.data || {};
  const code = (r && r.data && r.data.code) || (r && r.code) || 'e2ee5x_unavailable';
  _log('fail', { action, code });
  throw _err(code, r && r.message);
}

/** Mensagem curta para o usuário a partir do código (nunca o e.message cru). */
export function errorText(t, e) {
  const c = e && e.code;
  if (c === 'rate_limited') return _tx(t, 'e2ee5.x.rate_limited', 'Muitos pedidos seguidos. Tente de novo daqui a pouco.');
  if (c === 'e2ee5x_disabled') return _tx(t, 'e2ee5.x.disabled', 'Este recurso está indisponível agora.');
  if (c === 'cancelled') return '';
  return _tx(t, 'e2ee5.x.failed', 'Não foi possível concluir. Tente de novo.');
}

// ───────────────────────────────────────────────────────────── tradução

/**
 * Traduz UM texto escolhido. Aparelho primeiro (ML Kit, quando o binário tem); senão aviso +
 * servidor sem cache. → {translation, target, onDevice} | lança {code:'cancelled'|…}
 */
export async function translateExplicit(t, cid, text, target) {
  const body = String(text || '').trim();
  if (!body) throw _err('empty');
  const tgt = target || _locale(t);
  try {
    const od = require('../../utils/onDeviceML');
    if (od.getOnDeviceCapabilities().translate) {
      const r = await od.translateOnDevice(body, String(tgt).split('-')[0]);
      if (r && r.text) return { translation: r.text, target: tgt, sourceLang: r.sourceLang || null, onDevice: true };
    }
  } catch (_) {}
  if (!(await confirmExit(t, 'translate'))) throw _err('cancelled');
  const d = await _call('e2ee5x_translate', cid, { text: body.slice(0, 5000), target: tgt });
  if (!d.translation) throw _err('empty');
  return { translation: String(d.translation), target: d.target || tgt, sourceLang: d.source_lang || null, onDevice: false };
}

// ───────────────────────────────────────────────────────────── transcrição

function _localAudioSrc(msg) {
  if (!msg) return null;
  const cands = [msg._e5LocalUri, msg._decryptedUri, msg._localUri, msg.local_path];
  for (const c of cands) {
    if (typeof c !== 'string' || !c) continue;
    if (c.startsWith('file://') || c.startsWith('/') || c.startsWith('content://')) return c.startsWith('/') ? 'file://' + c : c;
    if (Platform.OS === 'web' && c.startsWith('blob:')) return c;
  }
  if (msg._e5Blob && Platform.OS === 'web') return msg._e5Blob;
  return null; // NUNCA a URL do servidor: em E2EE ela é o blob cifrado
}

/**
 * Transcreve áudio JÁ DECIFRADO neste aparelho.
 *  1) no aparelho (iOS SFSpeechRecognizer requiresOnDeviceRecognition / Android SpeechRecognizer
 *     on-device) — o áudio não sai do celular;
 *  2) se não deu e `allowServer` (toque do usuário): aviso + upload só deste áudio, sem cache.
 * → {text, onDevice} | {error}
 */
export async function transcribeExplicit(t, cid, src, lang, { allowServer = true } = {}) {
  if (!src) return { error: 'no_local_audio' };
  if (typeof src === 'string' && Platform.OS !== 'web') {
    try {
      const od = require('../../utils/onDeviceML');
      if (od.getOnDeviceCapabilities().transcribe) {
        const r = await od.transcribeOnDevice(src, { language: lang });
        if (r && r.text) return { text: r.text, onDevice: true };
        if (r && r.error === 'permission_denied' && !allowServer) return { error: 'permission_denied' };
      }
    } catch (_) {}
  }
  if (!allowServer) return { error: 'on_device_unavailable' };
  if (!(await confirmExit(t, 'transcribe'))) return { error: 'cancelled' };
  const api = _api();
  const form = new FormData();
  try {
    if (Platform.OS === 'web') {
      let blob = src;
      if (typeof src === 'string') blob = await (await fetch(src)).blob();
      form.append('file', blob, 'audio.m4a');
    } else {
      form.append('file', { uri: src, name: 'audio.m4a', type: 'audio/m4a' });
    }
  } catch (_) { return { error: 'no_local_audio' }; }
  form.append('conversation_id', String(cid));
  form.append('no_store', '1');
  if (lang) form.append('language', String(lang));
  const base = (api.getBaseUrl && api.getBaseUrl()) || api.BASE_URL || 'https://chatyy.com.br';
  const headers = { Accept: 'application/json' };
  const tok = api.getAuthToken && api.getAuthToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const tid = ctl ? setTimeout(() => ctl.abort(), 60000) : null;
  try {
    const resp = await fetch(`${base}/api/email.php?action=e2ee5x_transcribe`, { method: 'POST', body: form, headers, signal: ctl ? ctl.signal : undefined });
    const j = JSON.parse(await resp.text());
    if (j && j.success && j.data && j.data.transcript) return { text: String(j.data.transcript), onDevice: false };
    _log('transcribe_fail', { http: resp.status, code: j && j.data && j.data.code });
    return { error: (j && j.data && j.data.code) || 'failed' };
  } catch (_) {
    return { error: 'failed' };
  } finally { if (tid) clearTimeout(tid); }
}

/** Atalho para uma bolha de áudio. */
export function transcribeMessage(t, cid, msg, lang, opts) {
  return transcribeExplicit(t, cid, _localAudioSrc(msg), lang, opts);
}

// ───────────────────────────────────────────────────────────── resumo e Bia

/** items: [{n,t}] já escolhidos (ex.: excerptOf). → texto do resumo. */
export async function summarizeExplicit(t, cid, items, lang) {
  let list = (Array.isArray(items) ? items : []).filter((x) => x && x.t).slice(-SUM_MAX_ITEMS);
  let total = list.reduce((s, x) => s + String(x.t).length, 0);
  while (list.length && total > SUM_MAX_CHARS) { total -= String(list[0].t).length; list = list.slice(1); }
  if (list.length < 1) throw _err('empty');
  if (!(await confirmExit(t, 'summary'))) throw _err('cancelled');
  const d = await _call('e2ee5x_summarize', cid, { messages: list.map((x) => ({ n: String(x.n || '?').slice(0, 60), t: String(x.t) })), lang: lang || _locale(t) });
  return String(d.summary || '');
}

/** Pergunta à Bia com o trecho escolhido (pode ser vazio = só a pergunta). → resposta. */
export async function askBiaExplicit(t, cid, question, excerpt, lang) {
  const q = String(question || '').trim().slice(0, 2000);
  if (!q) throw _err('empty');
  let ex = (Array.isArray(excerpt) ? excerpt : []).filter((x) => x && x.t).slice(-ASK_MAX_ITEMS);
  let total = ex.reduce((s, x) => s + String(x.t).length, 0);
  while (ex.length && total > ASK_MAX_CHARS) { total -= String(ex[0].t).length; ex = ex.slice(1); }
  if (!(await confirmExit(t, 'bia'))) throw _err('cancelled');
  const d = await _call('e2ee5x_ask', cid, { question: q, excerpt: ex, lang: lang || _locale(t) });
  return String(d.answer || '');
}

/**
 * Resposta da Bia mostrada SÓ para quem perguntou (não vai ao servidor nem aos outros).
 * O núcleo ainda não publica `via:"bia"` (pedido ao WP-08c/09: opts.via no sealText).
 */
export function biaLocalRow(cid, answer, t) {
  const now = Date.now();
  return {
    id: -now, // negativo: nunca confundido com id do servidor
    conversation_id: Number(cid) || cid,
    sender_email: 'ai@chatyy.com.br',
    sender_name: _tx(t, 'e2ee5.x.bia_only_you', 'Bia · só você vê'),
    content: String(answer || ''),
    type: 'text',
    created_at: new Date(now).toISOString(),
    client_message_id: 'bia_local_' + now,
    _ai_bot: true,
    _e5Local: true,
    _localOnly: true,
  };
}

/** "@chatyy pergunta" numa conversa E2EE: aviso + só a pergunta vai ao servidor. → linha local | null */
export async function biaMention(t, cid, prompt) {
  try {
    const ans = await askBiaExplicit(t, cid, prompt, [], _locale(t));
    return ans ? biaLocalRow(cid, ans, t) : null;
  } catch (e) {
    if (e && e.code !== 'cancelled') {
      try { require('../alerts').safeAlert(_tx(t, 'common.error', 'Erro'), errorText(t, e)); } catch (_) {}
    }
    return null;
  }
}

// ───────────────────────────────────────────────────────────── denúncia

/**
 * Evidência que o DENUNCIANTE escolhe mandar em claro (como WhatsApp): até 10 mensagens — a
 * denunciada e as anteriores, ou as últimas da conversa. → {message_ids, evidence_texts}
 */
export function buildEvidence(messages, { anchorId = null, max = REPORT_MAX } = {}) {
  const rows = visibleTextRows(messages).filter((m) => typeof m.id === 'number' && m.id > 0);
  let pick = rows;
  if (anchorId != null) {
    const i = rows.findIndex((m) => String(m.id) === String(anchorId));
    if (i >= 0) pick = rows.slice(0, i + 1);
  }
  pick = pick.slice(-max);
  const ids = [];
  const texts = {};
  for (const m of pick) {
    ids.push(m.id);
    texts[String(m.id)] = String(plainOf(m) || m.transcript || '').slice(0, EVIDENCE_TEXT_MAX);
  }
  return { message_ids: ids, evidence_texts: texts };
}

/**
 * Denúncia em conversa E2EE. kind 'user' → chat_report_user; 'thread' → chat_report_thread
 * (bloquear/sair continuam lá). Sempre pergunta (always). → resposta da API | {cancelled:true}
 */
export async function reportExplicit(t, cid, { kind = 'thread', email = '', reason = '', action = 'report', messageId = null, alsoBlock = false, messages = [] } = {}) {
  if (!(await confirmExit(t, 'report', { always: true }))) return { success: false, cancelled: true };
  const ev = buildEvidence(messages, { anchorId: messageId });
  const api = _api();
  _log('report', { kind, n: ev.message_ids.length });
  if (kind === 'user') {
    const p = { email, reason, also_block: !!alsoBlock, conversation_id: Number(cid) || cid, ...ev };
    if (messageId) p.message_id = messageId;
    return api.apiCall('chat_report_user', p, 'POST');
  }
  return api.apiCall('chat_report_thread', { conversation_id: Number(cid) || cid, reason: reason || '', action, ...ev }, 'POST');
}

// ───────────────────────────────────────────────────────────── exportar (no aparelho)

const _TYPE_LABEL = { image: 'foto', video: 'vídeo', audio: 'áudio', voice: 'áudio', file: 'arquivo', sticker: 'figurinha', gif: 'GIF' };
// [e2ee5 WP-15] rótulo da mídia no export, traduzido (fallback = pt-BR acima)
function _typeLabel(t, type) {
  const k = type === 'voice' ? 'audio' : type;
  return _TYPE_LABEL[type] ? _tx(t, 'e2ee5.x.media_' + k, _TYPE_LABEL[type]) : '';
}

/**
 * Exporta a conversa a partir do que está decifrado NESTE aparelho (nada vai ao servidor).
 * messages = lista carregada na tela. → {content, mime, ext, count}
 */
export function exportConversationLocal({ t, messages, me, name = '', format = 'txt', from = null, to = null }) {
  const fromMs = from ? Date.parse(from) : 0;
  const toMs = to ? Date.parse(to) : Infinity;
  const rows = (Array.isArray(messages) ? messages : []).filter((m) => m && m.type !== 'system' && !m._e5Local && !m.deleted_at && !m.deleted_for_all)
    .map((m) => ({ m, ts: Date.parse(m.created_at || '') || 0 }))
    .filter((x) => x.ts >= fromMs && x.ts <= toMs)
    .sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const { m, ts } of rows) {
    const txt = plainOf(m);
    const media = _TYPE_LABEL[m.type] ? `<${_typeLabel(t, m.type)}>` : '';
    if (!txt && !media) continue; // não decifrada aqui → fica de fora (nunca o envelope)
    out.push({ id: m.id, at: new Date(ts || Date.now()).toISOString(), from: _nameOf(m, me, t), type: m.type || 'text', text: txt || media });
  }
  if (format === 'json') {
    return { content: JSON.stringify({ conversation: name, exported_at: new Date().toISOString(), e2ee: true, source: 'device', messages: out }, null, 2), mime: 'application/json', ext: 'json', count: out.length };
  }
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (iso) => { const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const head = _tx(t, 'e2ee5.x.export_head', 'Conversa exportada deste aparelho. As mensagens são protegidas com criptografia de ponta a ponta; este arquivo não é.');
  const lines = [head, ''];
  for (const r of out) lines.push(`${fmt(r.at)} - ${r.from}: ${r.text}`);
  return { content: lines.join('\n'), mime: 'text/plain', ext: 'txt', count: out.length };
}

export default {
  isOn, isE2eeConv, plainOf, visibleTextRows, excerptOf, confirmExit, errorText,
  translateExplicit, transcribeExplicit, transcribeMessage, summarizeExplicit, askBiaExplicit,
  biaLocalRow, biaMention, buildEvidence, reportExplicit, exportConversationLocal, REPORT_MAX,
};
