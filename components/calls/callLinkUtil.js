// components/calls/callLinkUtil.js — [call-link 2026-10-19] links de chamada (WhatsApp "Call links").
//
// Formato: https://chatyy.com.br/c/<código> (curto, 12 chars "k7mq-x2pd-9tfa") ou
// o antigo https://chatyy.com.br/call/<id> (hex). O app abre os dois em
// app/call/[id].js (lobby). Mensagem no chat = TEXTO com a URL (clientes antigos
// veem o link clicável); clientes novos reconhecem a URL e desenham o cartão
// (components/chat/CallLinkCard.js + nativeRowCards 'clink').

// Uma URL de link de chamada (com ou sem https://, com ou sem www.).
const URL_RE = /(?:https?:\/\/)?(?:www\.)?chatyy\.com\.br\/(?:c|call)\/([A-Za-z0-9-]{6,80})\/?(?=$|[\s?#)])/i;

/** Código normalizado (minúsculas, sem hífens) da 1ª URL de link de chamada no texto, ou ''. */
export function callLinkCodeFromText(text) {
  if (typeof text !== 'string' || text.length > 600) return '';
  const m = URL_RE.exec(text);
  if (!m) return '';
  const id = m[1].toLowerCase().replace(/-/g, '');
  return /^[a-z0-9]{6,64}$/.test(id) ? id : '';
}

/** true quando a URL (prévia de link) é um link de chamada do Chatyy. */
export function isCallLinkUrl(url) { return !!callLinkCodeFromText(String(url || '')); }

/** "k7mqx2pd9tfa" → "k7mq-x2pd-9tfa" (códigos novos de 12); id antigo fica igual. */
export function displayCode(id) {
  const s = String(id || '').toLowerCase().replace(/-/g, '');
  return s.length === 12 ? `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}` : s;
}

/** Rota do lobby no app. */
export function callLinkRoute(id) { return `/call/${displayCode(id)}`; }

/**
 * Mensagem de chat do link (texto puro = fallback de clientes antigos):
 *   "Chamada de vídeo do Chatyy: Reunião de sexta\nhttps://chatyy.com.br/c/…"
 * Cliente novo: cartão com título/tipo (lidos daqui) e botão Entrar.
 */
export function buildCallLinkMessage({ url, title, is_video }, t) {
  const kind = is_video
    ? _tr(t, 'callLink.kindVideo', 'Chamada de vídeo do Chatyy')
    : _tr(t, 'callLink.kindVoice', 'Chamada de voz do Chatyy');
  const ti = String(title || '').trim();
  return `${kind}${ti ? `: ${ti}` : ''}\n${url}`;
}

const _KIND_RE = /^(Chamada de vídeo do Chatyy|Chamada de voz do Chatyy|Chatyy video call|Chatyy voice call|Videollamada de Chatyy|Llamada de voz de Chatyy)(?::\s*(.*))?$/i;

/**
 * Lê o cartão de uma mensagem de texto. → null (não é link de chamada) |
 * { code, url, title, isVideo, own: bool? } — título/tipo vêm da 1ª linha quando
 * a mensagem foi gerada por buildCallLinkMessage; URL avulsa → vídeo sem título.
 * Só vira cartão quando a mensagem é PRATICAMENTE só o link (até 2 linhas).
 */
export function parseCallLinkMessage(content) {
  if (typeof content !== 'string') return null;
  const c = content.trim();
  if (!c || c.length > 300) return null;
  const code = callLinkCodeFromText(c);
  if (!code) return null;
  const lines = c.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 2) return null;
  const urlLine = lines[lines.length - 1];
  if (!URL_RE.test(urlLine) || urlLine.replace(URL_RE, '').trim()) return null;
  let title = '';
  let isVideo = true;
  if (lines.length === 2) {
    const m = _KIND_RE.exec(lines[0]);
    if (!m) return null;
    isVideo = !/voz|voice/i.test(m[1]);
    title = String(m[2] || '').trim().slice(0, 60);
  }
  const url = /^https?:\/\//i.test(urlLine) ? urlLine : `https://${urlLine}`;
  return { code, url, title, isVideo };
}

export async function copyText(text) {
  try {
    const { Platform } = require('react-native');
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const Clipboard = require('expo-clipboard');
    await Clipboard.setStringAsync(text);
    return true;
  } catch { return false; }
}

function _tr(t, k, fb) {
  try { const v = t ? t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; }
}
