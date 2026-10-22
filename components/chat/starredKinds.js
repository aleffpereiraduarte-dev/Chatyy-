// components/chat/starredKinds.js — [2026-10-21 favoritas-pro]
// Classificação e miniatura das mensagens favoritas, compartilhadas pela tela
// "Salvas e favoritas" (app/starred-messages.js) e pela folha da conversa
// (components/chat/StarredMessagesSheet.js).
//
//   starredKind(m)   → 'photo' | 'video' | 'link' | 'file' | 'audio' | 'text' | 'other'
//   starredThumb(m)  → { uri, blurhash } da miniatura (foto/vídeo/GIF) ou null
//   firstLink(text)  → { url, host } do 1º link do texto ou null
//   STARRED_FILTERS  → ordem dos filtros (chips) — rótulos ficam com quem desenha
//
// Miniatura (o bug do founder: foto favoritada SEM miniatura): o
// chat_starred_messages servido por email.php não trazia file_url; o servidor
// agora manda file_url + image_variants (t320) + thumbnail_url + blurhash. Aqui a
// ordem é a mais LEVE primeiro: t320 → disp → original (vídeo: pôster). URL
// relativa (/data/…) vira absoluta via api.getMediaUrl.
import * as api from '../../services/api';

export const STARRED_FILTERS = ['all', 'photo', 'video', 'link', 'file', 'audio', 'text'];

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/i;
const WWW_RE = /\bwww\.[a-z0-9-]+(\.[a-z0-9-]+)+[^\s<>"')]*/i;
const MEDIA_HOST_RE = /^https?:\/\/(media[0-9]*\.)?(tenor|giphy)\.com\//i;

function _parsed(m) {
  const c = typeof m?.content === 'string' ? m.content.trim() : '';
  if (!c.startsWith('{')) return null;
  try { return JSON.parse(c); } catch { return null; }
}

function _iv(m) {
  let iv = m && m.image_variants;
  if (typeof iv === 'string') { try { iv = JSON.parse(iv); } catch { iv = null; } }
  return iv && typeof iv === 'object' ? iv : null;
}

function _abs(u) {
  if (!u || typeof u !== 'string') return '';
  if (/^(file|content|ph|data|blob|assets-library):/i.test(u)) return u;
  try { return api.getMediaUrl(u) || ''; } catch { return u; }
}

export function firstLink(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s) return null;
  let url = (s.match(URL_RE) || [])[0] || '';
  if (!url) { const w = (s.match(WWW_RE) || [])[0]; if (w) url = 'https://' + w; }
  if (!url) return null;
  url = url.replace(/[.,;:!?]+$/, '');
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./i, ''); } catch { host = url.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, ''); }
  return host ? { url, host } : null;
}

/** Texto "visível" (sem JSON/nome de arquivo) usado p/ link e busca. */
export function starredPlainText(m) {
  const p = _parsed(m);
  if (p) {
    if (p.e2e) return '';
    const t = [p.text, p.body, p.caption, p.message, p.question].find((x) => typeof x === 'string' && x.trim());
    return t ? t.trim() : '';
  }
  const c = typeof m?.content === 'string' ? m.content.trim() : '';
  if (typeof m?.caption === 'string' && m.caption.trim()) return m.caption.trim();
  return c;
}

export function starredKind(m) {
  if (!m) return 'other';
  const type = String(m.type || m.message_type || 'text');
  if (type === 'image' || type === 'gif') return 'photo';
  if (type === 'video') return 'video';
  if (type === 'audio' || type === 'voice' || type === 'ptt') return 'audio';
  if (type === 'file' || type === 'document') return 'file';
  if (type === 'sticker' || type === 'lottie_sticker' || type === 'location' || type === 'live_location'
    || type === 'contact' || type === 'poll' || type === 'call_card') return 'other';
  const p = _parsed(m);
  if (p) {
    if (p.e2e) return 'text';
    if (typeof p.latitude === 'number' || p.type === 'contact' || (typeof p.question === 'string' && Array.isArray(p.options)) || p.call_id) return 'other';
  }
  const plain = starredPlainText(m);
  if (MEDIA_HOST_RE.test(plain)) return 'photo';
  if (m.has_link === true || m.has_link === 1 || m.has_link === 't' || firstLink(plain)) return 'link';
  if (!plain && m.file_url) return 'file';
  return 'text';
}

/** Miniatura de foto/vídeo/GIF: { uri, blurhash } ou null (visualização única → null). */
export function starredThumb(m) {
  if (!m || m.is_view_once === true || m.is_view_once === 1 || m.view_once) return null;
  const type = String(m.type || '');
  const iv = _iv(m);
  const blurhash = (typeof m.blurhash === 'string' && m.blurhash) || (iv && typeof iv.blurhash === 'string' && iv.blurhash) || '';
  let u = '';
  if (type === 'image' || type === 'video') {
    u = (iv && (iv.thumb || iv.t320 || iv.poster)) || m.thumb_url || m.thumbnail_url || (iv && iv.display) || m.poster_url || m.video_thumb || '';
    if (typeof u !== 'string') u = '';
    if (!u && m.thumb_b64 && typeof m.thumb_b64 === 'string') return { uri: `data:image/jpeg;base64,${m.thumb_b64}`, blurhash };
    if (!u && typeof m.file_url === 'string' && m.file_url) {
      if (type === 'image') u = m.file_url;
      else if (/\/data\/chat-files\//.test(m.file_url) && !/\.thumb\.jpg$/i.test(m.file_url)) u = `${m.file_url}.thumb.jpg`;
    }
  } else if (type === 'gif') {
    const p = _parsed(m);
    u = m.file_url || (p && (p.url || p.gif_url)) || '';
  } else {
    const plain = starredPlainText(m);
    if (MEDIA_HOST_RE.test(plain)) u = plain;
  }
  const uri = _abs(u);
  return uri || blurhash ? { uri, blurhash } : null;
}

/** Tudo que a busca olha (texto, legenda, nome do arquivo, link). */
export function starredSearchText(m, extra) {
  const parts = [starredPlainText(m), m?.file_name || '', m?.sender_name || '', m?.conversation_name || '', extra || ''];
  return parts.join(' \u0001 ').toLowerCase();
}

/** Normaliza p/ busca: minúsculas e sem acento ("Fotografia" ~ "fotografía"). */
export function foldSearch(s) {
  const v = String(s || '').toLowerCase();
  try { return v.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch { return v; }
}
