// [2026-10-17 peek-fit] Itens da prévia do toque longo (lista nativa e
// fileira de fixados — iOS CLPeekController / Android CLPeekDialog).
// Antes: só texto ("Foto", "GIF", "Figurinha"), ✓ cinza em tudo (o recibo vinha
// do read_at/delivered_at por linha, que o cache quase nunca tem) e sem hora
// quando created_at não estava no formato esperado.
// Agora, por item: {m, t, h, s, r} (binário antigo continua igual) +
//   k: 'image'|'video'|'gif'|'sticker', u: miniatura (arquivo local > thumb >
//   CDN), c: legenda, w/h2: dimensões — o nativo novo desenha a miniatura real;
//   r: recibo MONOTÔNICO igual à conversa (computeTickState): em 1:1 lido =
//   id <= watermark do peer (visto guardado ao abrir a conversa + read_at/read_by
//   do peer no cache), entregue = id <= watermark de entrega.
// Kill switch: globalThis.__chatyy_peek_media === false → só texto (como antes).
import { splitPreviewIcon } from './nativeAdapter';

const MEDIA_KINDS = { image: 'image', video: 'video', gif: 'gif', sticker: 'sticker' };

function _hhmm(msg) {
  const cands = [msg.created_at, msg.sent_at, msg.timestamp, msg._ts, msg.client_ts, msg.ts];
  for (const raw0 of cands) {
    if (raw0 == null || raw0 === '') continue;
    let d = null;
    if (typeof raw0 === 'number' || /^\d{9,}$/.test(String(raw0))) {
      const n = Number(raw0);
      d = new Date(n < 1e12 ? n * 1000 : n);
    } else {
      const raw = String(raw0);
      d = new Date(raw.replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(raw) ? '' : 'Z'));
    }
    if (d && !isNaN(d.getTime())) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return '';
}

function _peerIn(list, me) {
  if (Array.isArray(list)) {
    return list.some((x) => {
      const e = (typeof x === 'string' ? x : (x && (x.email || x.user_email || x.user))) || '';
      return !e || e.toLowerCase() !== me;
    });
  }
  if (typeof list === 'string' && list.trim()) return list.trim().toLowerCase() !== me;
  return false;
}

function _variants(m) {
  if (!m.image_variants) return null;
  try { return typeof m.image_variants === 'string' ? JSON.parse(m.image_variants) : m.image_variants; } catch { return null; }
}

let _mc = null;
function _mediaCache() {
  if (_mc === null) { try { _mc = require('../../services/mediaCache'); } catch { _mc = false; } }
  return _mc || null;
}
let _api = null;
function _getMediaUrl(u) {
  if (!u) return '';
  if (_api === null) { try { _api = require('../../services/api'); } catch { _api = false; } }
  try { return (_api && _api.getMediaUrl) ? _api.getMediaUrl(u) : u; } catch { return u; }
}

function _isRemote(u) {
  if (typeof u !== 'string') return false;
  const v = u.trim();
  return /^(https?:)?\/\//i.test(v) || v.startsWith('/');
}

/** Miniatura p/ a prévia: arquivo local (sem rede) > thumb do servidor > CDN. */
function _mediaUri(msg, kind) {
  const mc = _mediaCache();
  let fileUrl = typeof msg.file_url === 'string' ? msg.file_url.trim() : '';
  if (!fileUrl && (kind === 'gif' || kind === 'sticker') && typeof msg.content === 'string') {
    const c = msg.content.trim();
    if (/^https?:\/\//i.test(c)) fileUrl = c.replace(/\s+/g, '');
  }
  if (kind === 'sticker' && /\.(json|tgs)(\?|$)/i.test(fileUrl)) return ''; // lottie: sem miniatura estática
  if (kind === 'video') {
    const iv = _variants(msg);
    const p = msg._posterUri || msg.thumbnail_url || msg.poster_url || msg.video_thumb || (iv && (iv.poster || iv.thumb)) || '';
    if (p) {
      if (/^(data:|file:)/.test(p)) return p;
      const abs = _getMediaUrl(p);
      try { const loc = mc && mc.getLocalUriSyncJs && mc.getLocalUriSyncJs(abs); if (loc) return loc; } catch {}
      return abs;
    }
    try { const b64 = msg.thumb_b64 || (mc && mc.getThumbB64Sync && mc.getThumbB64Sync(msg.id)); if (b64) return `data:image/jpeg;base64,${b64}`; } catch {}
    return '';
  }
  // Foto / GIF / figurinha: arquivo já no aparelho primeiro.
  try {
    if (fileUrl && _isRemote(fileUrl) && mc && mc.getLocalUriSyncJs) {
      const loc = mc.getLocalUriSyncJs(_getMediaUrl(fileUrl));
      if (loc) return loc;
    }
    if (typeof msg.id === 'number' && msg.id > 0 && mc && mc.getLocalUriForMessage) {
      const loc = mc.getLocalUriForMessage(msg.id);
      if (loc) return loc;
    }
  } catch {}
  if (kind === 'image') {
    const iv = _variants(msg);
    if (iv && typeof iv.thumb === 'string' && iv.thumb) return _getMediaUrl(iv.thumb);
    if (iv && typeof iv.display === 'string' && iv.display && !msg._blurred) return _getMediaUrl(iv.display);
  }
  if (fileUrl) return _getMediaUrl(fileUrl);
  try { const b64 = msg.thumb_b64 || (mc && mc.getThumbB64Sync && mc.getThumbB64Sync(msg.id)); if (b64) return `data:image/jpeg;base64,${b64}`; } catch {}
  return '';
}

function _kindOf(msg) {
  const t = String(msg.type || '');
  if (t === 'lottie_sticker') return '';
  if (MEDIA_KINDS[t]) return MEDIA_KINDS[t];
  if (t === 'text' || !t) {
    const c = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (/^https?:\/\/(media[0-9]*\.)?(tenor|giphy)\.com\//i.test(c)) return 'gif';
    if (/^https?:\/\/\S+\/(sticker-files|stickers)\/\S+\.(webp|png|gif)$/i.test(c)) return 'sticker';
  }
  return '';
}

function _isViewOnce(m) { return !!(m && (m.is_view_once || m.isViewOnce || m.view_once)); }

/**
 * conv: conversa (id, type, members, last_message); c: { me, computePreview, emailToDisplayName }.
 * Devolve até 12 itens (mais antigos → mais novos).
 */
export function buildPeekItems(conv, c) {
  const { getCachedMessagesSync } = require('../../services/smartChatCache');
  const msgs = getCachedMessagesSync(conv.id, 40) || [];
  const me = String(c.me || '').toLowerCase();
  const isGroup = conv.type === 'group' || conv.type === 'channel';
  const mediaOn = globalThis.__chatyy_peek_media !== false;

  // Watermarks (1:1): leitura/entrega do peer, monotônicos (computeTickState).
  let readWm = -1;
  let delivWm = -1;
  if (!isGroup) {
    try { readWm = require('../../services/peekReceipts').getPeerRead(me, conv.id); } catch {}
    const scan = msgs.slice();
    const lm = conv.last_message;
    if (lm && typeof lm === 'object') scan.push(lm);
    for (const msg of scan) {
      if (!msg || String(msg.sender_email || '').toLowerCase() !== me) continue;
      const idN = Number(msg.id);
      if (!Number.isFinite(idN) || idN <= 0) continue;
      if (msg.read_at || _peerIn(msg.read_by, me)) { if (idN > readWm) readWm = idN; }
      if (msg._delivered || msg.delivered_at || msg.read_at || _peerIn(msg.delivered_to, me)) { if (idN > delivWm) delivWm = idN; }
    }
    if (readWm > delivWm) delivWm = readWm;
  }

  const items = [];
  for (const msg of msgs) {
    if (!msg || msg.deleted_at || msg.deleted || msg.type === 'system') continue;
    const mine = String(msg.sender_email || '').toLowerCase() === me;
    let txt = '';
    let st = null;
    try {
      const r = c.computePreview(msg, isGroup, conv.type === 'channel', c.me, conv.members) || {};
      txt = splitPreviewIcon(r.preview || '').text;
      st = r.statusType || null;
    } catch {}
    const h = _hhmm(msg);
    const s = (!mine && isGroup) ? (c.emailToDisplayName ? c.emailToDisplayName(msg.sender_name || msg.sender_email || '') : '') : '';
    let r = 0;
    if (mine) {
      const idN = Number(msg.id);
      if (msg._failed || msg._pending || msg._queued || !(idN > 0)) r = 1;
      else if (isGroup) r = (st === 'read' || msg._read === true) ? 3 : (st === 'delivered' || msg._delivered) ? 2 : 1;
      else if (readWm >= 0 && idN <= readWm) r = 3;
      else if (st === 'read') r = 3;
      else if ((delivWm >= 0 && idN <= delivWm) || st === 'delivered') r = 2;
      else r = 1;
    }
    const it = { m: mine, t: (txt || '').slice(0, 280), h, s, r };
    if (mediaOn && !_isViewOnce(msg)) {
      const k = _kindOf(msg);
      if (k) {
        let u = '';
        try { u = _mediaUri(msg, k); } catch {}
        if (u && !(u.startsWith('data:') && u.length > 60000)) {
          it.k = k;
          it.u = u;
          let cap = typeof msg.caption === 'string' ? msg.caption.trim() : '';
          if (!cap && (k === 'image' || k === 'video') && typeof msg.content === 'string') {
            // legenda em `content` (texto puro; nunca URL/JSON/nome de arquivo)
            const cc = msg.content.trim();
            if (cc && !/^(https?:|file:|\{|\/)/i.test(cc) && !/\.(jpe?g|png|gif|webp|heic|heif|mp4|mov|m4v|webm)$/i.test(cc) && (/\s/.test(cc) || cc.length <= 14)) cap = cc;
          }
          if (cap && k !== 'sticker') it.c = cap.slice(0, 200);
          const iv = k === 'image' ? _variants(msg) : null;
          const w = Number(msg.width) || Number(iv && iv.full_w) || 0;
          const hh = Number(msg.height) || Number(iv && iv.full_h) || 0;
          if (w > 0 && hh > 0) { it.w = w; it.h2 = hh; }
          if (!it.t) it.t = k === 'sticker' ? 'Figurinha' : k === 'gif' ? 'GIF' : k === 'video' ? 'Vídeo' : 'Foto';
        }
      }
    }
    if (!it.t) continue;
    items.push(it);
  }
  return items.slice(-12);
}
