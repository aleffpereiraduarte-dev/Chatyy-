// [2026-10-23 lista-e2ee] Prévia da LISTA de conversas para a última mensagem E2EE v5, nível WhatsApp.
//
// Bug do founder: chegava mensagem nova numa conversa protegida (ex. 959) e a prévia virava um rótulo
// genérico ("Mensagem" / "Nova mensagem") em vez do texto — o servidor só tem o envelope cifrado, a
// linha chegava (WS / push / chat_list) antes de o aparelho decifrar e o push em 2º plano ainda
// TROCAVA o envelope por texto vazio/genérico (bgJournal), então a lista nem tinha o que decifrar.
//
// Regras daqui:
//   • texto decifrado NESTE aparelho (memória do e2ee5 → store nativo → cache local desta prévia);
//   • a prévia decifrada fica guardada por conversa (MMKV no celular, só memória na web) com o id da
//     mensagem e a chave do envelope — volta na hora depois de reload/OTA, nunca vai ao servidor;
//   • enquanto decifra (GRACE_MS) quem chama MANTÉM a prévia anterior (state 'pending');
//   • não deu para decifrar → "Mensagem criptografada" com glifo de cadeado (🔒 = só marcador interno,
//     a lista desenha o SVG/SF Symbol "lock"; nunca emoji na tela). Nunca "Mensagem".
//   • mídia cifrada: tipo FINO do payload (Foto/GIF/Figurinha/Vídeo/Áudio/Arquivo…), não o tipo grosso
//     em claro (figurinha/GIF vinham como "Foto").
//
// Kill switches (OTA): globalThis.__chatyy_e5_list_preview = false → caminho antigo (e2ee5.previewText);
// globalThis.__chatyy_e5_list_preview_mmkv = false → não grava/lê o cache persistido (só memória).
import { Platform } from 'react-native';

const GRACE_MS = 6000;
const TEXT_MAX = 200;
const LOCK = '🔒 ';

const _g = () => (typeof globalThis !== 'undefined' ? globalThis : global);
export function isOn() { try { return _g().__chatyy_e5_list_preview !== false; } catch (_) { return true; } }
const _persistOn = () => { try { return _g().__chatyy_e5_list_preview_mmkv !== false; } catch (_) { return true; } };

function _tx(t, key, fb) {
  try { const v = t ? t(key) : null; return typeof v === 'string' && v && v !== key ? v : fb; } catch (_) { return fb; }
}
export function lockedLabel(t) { return LOCK + _tx(t, 'e2ee.listPreview', 'Mensagem criptografada'); }

function _acct() {
  try {
    const a = require('../api');
    return String((a.getActiveAccountEmail && a.getActiveAccountEmail()) || (a.getTokenMeta && a.getTokenMeta().email) || '').trim().toLowerCase();
  } catch (_) { return ''; }
}

// ── cache persistido (MMKV próprio; a web fica só na memória — sem texto em localStorage)
let _kv;
function _store() {
  if (_kv !== undefined) return _kv;
  _kv = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try { const { MMKV } = require('react-native-mmkv'); _kv = new MMKV({ id: 'chatyy-e5prev' }); } catch (_) { _kv = null; }
  return _kv;
}
const _mem = new Map(); // acct|conv → {mid, k, text, ts}
function _ck(conv) { const a = _acct(); return a && conv ? a + '|' + conv : ''; }

export function getCached(conv) {
  const ck = _ck(String(conv || ''));
  if (!ck) return null;
  if (_mem.has(ck)) return _mem.get(ck);
  let v = null;
  if (_persistOn()) {
    try { const s = _store()?.getString('p|' + ck); if (s) { const o = JSON.parse(s); if (o && typeof o.text === 'string') v = o; } } catch (_) {}
  }
  _mem.set(ck, v);
  if (_mem.size > 3000) _mem.delete(_mem.keys().next().value);
  return v;
}

export function remember(conv, mid, k, text) {
  const ck = _ck(String(conv || ''));
  if (!ck || typeof text !== 'string' || !text) return;
  const cur = _mem.get(ck);
  const m = mid != null && /^\d+$/.test(String(mid)) ? String(mid) : '';
  if (cur && cur.text === text && cur.k === k && (cur.mid === m || !m)) return;
  // nunca regride: uma linha mais VELHA decifrada depois (histórico) não toma o lugar da prévia nova
  if (cur && cur.mid && m && Number(m) < Number(cur.mid)) return;
  const v = { mid: m || (cur && cur.k === k ? cur.mid : ''), k: k || '', text: text.slice(0, TEXT_MAX), ts: Date.now() };
  _mem.set(ck, v);
  if (_persistOn()) { try { _store()?.set('p|' + ck, JSON.stringify(v)); } catch (_) {} }
}

/** Logout / troca de conta / limpar cache do chat. */
export function clearAll() {
  _mem.clear();
  _seen.clear();
  try { _store()?.clearAll(); } catch (_) {}
}

// ── espera curta mantendo a prévia anterior; ao vencer, repinta (vira cadeado se ainda não abriu)
const _seen = new Map(); // chave → 1ª vez vista (ms)
function _graceLeft(key, conv) {
  const now = Date.now();
  let t0 = _seen.get(key);
  if (t0 == null) {
    t0 = now; _seen.set(key, t0);
    if (_seen.size > 4000) _seen.delete(_seen.keys().next().value);
    try {
      setTimeout(() => {
        try { require('../websocket').default?._emit?.('e2ee5_plain', { conversation_id: conv, key, hold: 'list_grace' }); } catch (_) {}
      }, GRACE_MS + 30);
    } catch (_) {}
  }
  return t0 + GRACE_MS - now;
}

function _fmtDur(d) {
  const n = Math.round(Number(d) || 0);
  if (!(n > 0)) return '';
  const m = Math.floor(n / 60); const s = n % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}
// mesmo achatamento de marcação da prévia em claro (**negrito**, _itálico_, ~riscado~, `código`, ||spoiler||)
function _flat(s) {
  return String(s || '')
    .replace(/```([\s\S]*?)```/g, '$1')
    .replace(/\|\|([^|]+)\|\|/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/~([^~\n]+)~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Entrada decifrada do e2ee5 → prévia (com glifo-marcador de tipo). '' = não sabe mostrar. */
export function previewOfEntry(e, t, mid) {
  if (!e) return '';
  const p = (e.payload && typeof e.payload === 'object') ? e.payload : {};
  const ty = String(p.t || e.t || 'text');
  const T = (k, fb) => _tx(t, k, fb);
  const cap = typeof p.caption === 'string' && p.caption.trim() ? _flat(p.caption).slice(0, 120) : '';
  let M = null;
  try { M = require('./payload').mainMedia(p); } catch (_) {}
  switch (ty) {
    case 'text': case 'edit': {
      let body = typeof p.body === 'string' ? p.body : (e.text || '');
      try { const ed = mid != null ? require('./e2ee5').editOf(mid, e.sender) : null; if (ed && typeof ed.text === 'string' && ed.text) body = ed.text; } catch (_) {}
      return _flat(body).slice(0, TEXT_MAX);
    }
    case 'image': return '📷 ' + (cap || T('chat.photo', 'Foto'));
    case 'gif': return '🎬 ' + (cap || 'GIF');
    case 'sticker': return '💫 ' + T('chat.sticker', 'Figurinha');
    case 'video': return '🎥 ' + (cap || (p.round ? T('chat.videoNote', 'Vídeo-recado') : T('chat.video', 'Vídeo')));
    case 'voice': return '🎙 ' + (_fmtDur(M && M.dur != null ? M.dur : p.dur) || T('chat.voiceMessage', 'Mensagem de voz'));
    case 'audio': return '🎙 ' + (cap || (M && M.name) || T('chat.audio', 'Áudio'));
    case 'file': return '📄 ' + ((M && M.name) || cap || T('chat.file', 'Arquivo'));
    case 'location': return '📍 ' + (p.live ? T('chat.liveLocation', 'Localização em tempo real') : T('chat.location', 'Localização'));
    case 'location_request': return '📍 ' + T('chat.locationRequest', 'Pediu sua localização');
    case 'contact': { const c = Array.isArray(p.contacts) ? p.contacts : []; return '👤 ' + T('chat.contact', 'Contato') + (c[0] && c[0].name ? ': ' + c[0].name : ''); }
    case 'poll': return '📊 ' + (p.question ? String(p.question).slice(0, 80) : T('chat.poll', 'Enquete'));
    case 'meetup': return '📅 ' + (p.title ? String(p.title).slice(0, 80) : T('chatConv.meetup', 'Encontro'));
    default: return '';
  }
}

/**
 * Prévia da última mensagem v5 para a lista (síncrona).
 * → null                                  não é envelope v5 (ou kill switch) → caminho de hoje
 * → {state:'ok', text}                    texto/rótulo decifrado neste aparelho
 * → {state:'pending', text}               decifrando: quem chama mantém a prévia anterior; `text` = a última
 *                                         prévia decifrada guardada desta conversa ou o cadeado
 * → {state:'locked', text}                não decifra aqui → "🔒 Mensagem criptografada"
 */
export function listPreview(lastMsg, t, convId) {
  if (!isOn() || !lastMsg || typeof lastMsg !== 'object') return null;
  const conv = convId != null ? String(convId) : (lastMsg.conversation_id != null ? String(lastMsg.conversation_id) : '');
  const mid = lastMsg.id != null && /^\d+$/.test(String(lastMsg.id)) ? String(lastMsg.id) : '';
  // linha montada pelo push em 2º plano sem envelope (só "chegou msg nova"): espera a linha real
  if (lastMsg._e5pending) {
    const c = getCached(conv);
    if (c && mid && c.mid === mid) return { state: 'ok', text: c.text };
    if (_graceLeft('m|' + conv + '|' + mid, conv) > 0) return { state: 'pending', text: (c && c.text) || lockedLabel(t) };
    return { state: 'locked', text: lockedLabel(t) };
  }
  const s = typeof lastMsg.content === 'string' ? lastMsg.content.trim() : '';
  let E;
  try { E = require('./e2ee5'); } catch (_) { return null; }
  if (!s || !E.isV5Family(s)) return null;
  const k = E.keyOf(s);
  let e = E.peek(s);
  // previewText: store nativo (ingestão/NSE) síncrono + dispara a decifra em 2º plano (e2ee5_plain repinta)
  if (!e) { try { E.previewText(lastMsg, t, conv || undefined); } catch (_) {} e = E.peek(s); }
  if (e) {
    const txt = previewOfEntry(e, t, mid || e.mid);
    if (txt) { remember(conv, mid || e.mid, k, txt); return { state: 'ok', text: txt }; }
    return { state: 'locked', text: lockedLabel(t) };
  }
  const c = getCached(conv);
  if (c && ((mid && c.mid === mid) || (k && c.k === k))) return { state: 'ok', text: c.text };
  let fail = null;
  try { fail = E.peekFailure(s); } catch (_) {}
  const cantHere = E.envVersion(s) !== 5 || !E.isOn() || (fail && fail !== 'waiting');
  if (!cantHere && _graceLeft(k || ('m|' + conv + '|' + mid), conv) > 0) return { state: 'pending', text: (c && c.text) || lockedLabel(t) };
  return { state: 'locked', text: lockedLabel(t) };
}
