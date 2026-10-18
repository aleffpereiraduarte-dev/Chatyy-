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

/** [2026-10-18 peek-full] últimas N mensagens (nativo novo desenha até 15; antigo corta em 12). */
export const PEEK_MAX = 15;

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

// [2026-10-18 peek-full] Fonte das mensagens da prévia = a MESMA da 1ª pintura
// da conversa (services/chatStore.getMessagesSync: SQLite canônico → MMKV).
// Antes só lia o smartChatCache (MMKV/memória), que fica FRIO para a maioria
// das conversas (o sync grava no SQLite; o acelerador só esquenta ao abrir a
// conversa) → items vazio → o nativo caía no "seed" da linha: cartão vazio e
// só a última mensagem embaixo (print do founder 18/10). Mescla as duas fontes
// por id (pendentes/otimistas do acelerador entram), ordem antiga → nova.
function _peekSource(convId, limit, me) {
  let a = [];
  let b = [];
  try { a = require('../../services/chatStore').getMessagesSync(convId, limit) || []; } catch { a = []; }
  try { b = require('../../services/smartChatCache').getCachedMessagesSync(convId, limit) || []; } catch { b = []; }
  if (!a.length && !b.length && me) {
    // último recurso: store nativo (fase 2, raw do servidor) — mesmo dado da lista nativa
    try { a = require('../../services/nativeChatStore').nativeMessagesSync(me, convId, limit) || []; } catch { a = []; }
  }
  if (!a.length) return b.slice(-limit);
  if (!b.length) return a.slice(-limit);
  const seen = new Set();
  const out = [];
  const key = (m) => (m && (m.id != null ? 'i' + m.id : (m.temp_id || m.client_message_id || m._tempId || ''))) || '';
  for (const m of a) { const k = key(m); if (k) seen.add(k); out.push(m); }
  let maxId = 0;
  for (const m of a) { const n = Number(m && m.id); if (Number.isFinite(n) && n > maxId) maxId = n; }
  for (const m of b) {
    const k = key(m);
    if (k && seen.has(k)) continue;
    const n = Number(m && m.id);
    // só o que é MAIS NOVO que o SQLite (ou ainda sem id do servidor)
    if (Number.isFinite(n) && n > 0 && n <= maxId) continue;
    if (k) seen.add(k);
    out.push(m);
  }
  return out.slice(-limit);
}

/**
 * conv: conversa (id, type, members, last_message); c: { me, computePreview, emailToDisplayName }.
 * Devolve até PEEK_MAX itens (mais antigos → mais novos).
 */
export function buildPeekItems(conv, c) {
  const me = String(c.me || '').toLowerCase();
  const msgs = _peekSource(conv.id, 40, me);
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
  return items.slice(-PEEK_MAX);
}

// [2026-10-17 peek-fixed] Altura do cartão da prévia (toque longo) = fração
// FIXA da tela, a mesma em toda conversa (WhatsApp). O nativo novo já usa 0.42
// por padrão; esta prop só permite ajustar por OTA (binários com a prop:
// lista iOS api >= 4 / Android api >= 5, fixados iOS api >= 2 — o chamador
// checa). Ajuste: globalThis.__chatyy_peek_height = 0.2..0.7; false = não
// manda a prop (nativo usa o padrão).
export const PEEK_HEIGHT_DEFAULT = 0.42;
export function peekHeightFraction() {
  const g = globalThis.__chatyy_peek_height;
  if (g === false) return 0;
  const n = Number(g);
  if (g != null && Number.isFinite(n) && n >= 0.2 && n <= 0.7) return n;
  return PEEK_HEIGHT_DEFAULT;
}

// ─── [2026-10-18 peek-full] Fundo da prévia = fundo da conversa ──────────────
// Mesma resolução de chat-conversation.js (wallpaperColor): por conversa (MMKV
// `wallpaper_<id>`) → configuração da conta (chat_settings_v1.wallpaper) →
// padrão local (wallpaper_default) → 'none'. Devolve o que o nativo desenha
// (lista iOS api >= 8 / Android api >= 8; binário antigo ignora a chave `bg`):
//   c  cor de base (#RRGGBB)        u/ua  foto (uri + opacidade sobre a base)
//   p  padrão {tile, stroke, items} pc/pi/ps  cor/opacidade/escala do traço
//   ob/oi  balão próprio (fundo/tinta)   rb  balão recebido
// Kill switch: globalThis.__chatyy_peek_bg === false → sem `bg` (cinza antigo).

function _hexRgb(h) {
  const s = String(h || '').replace('#', '');
  const v = s.length === 3 ? s.split('').map((x) => x + x).join('') : s.slice(0, 6);
  const n = parseInt(v, 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function _mix(base, over, a) {
  const b = _hexRgb(base); const o = _hexRgb(over);
  const h = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0');
  return `#${h(b[0] + (o[0] - b[0]) * a)}${h(b[1] + (o[1] - b[1]) * a)}${h(b[2] + (o[2] - b[2]) * a)}`;
}

function _wallpaperValue(convId, me) {
  try {
    const mmkv = require('../../services/mmkv');
    const v = mmkv.getString(`wallpaper_${convId}`);
    if (v && v !== '__global__') return v;
  } catch {}
  try {
    const h = require('../../utils/chatOpenHandoff');
    const cs = me ? h.getCachedChatSettings(me) : null;
    if (cs && typeof cs.wallpaper === 'string' && cs.wallpaper) return cs.wallpaper;
    const lp = h.getCachedLocalPrefs ? h.getCachedLocalPrefs() : null;
    if (lp && typeof lp.wallpaper_default === 'string' && lp.wallpaper_default) return lp.wallpaper_default;
  } catch {}
  return 'none';
}

function _patternProp(pat) {
  return pat ? { tile: pat.tile, stroke: pat.stroke, items: pat.items } : null;
}

export function buildPeekBg(convId, isDark, me) {
  if (globalThis.__chatyy_peek_bg === false) return null;
  try {
    const dark = !!isDark;
    const base = dark ? '#000000' : '#FFFFFF';
    // Balões iguais aos da conversa (chat-conversation.js ~11815).
    const out = { c: base, ob: dark ? '#333336' : '#111111', oi: dark ? '#F5F5F7' : '#FFFFFF', rb: dark ? '#1C1C1E' : '#EEEEF0' };
    const value = _wallpaperValue(convId, String(me || '').toLowerCase());
    const spec = require('../wallpaper/wallpaperSpec');
    if (value === 'none' || !value) {
      // padrão: liso + rabiscos P&B quase invisíveis (SubtlePattern)
      let subtle = true;
      try { subtle = require('../wallpaper/SubtlePattern').subtlePatternOn(); } catch {}
      if (subtle) {
        out.p = _patternProp(spec.patternById('doodles'));
        out.pc = dark ? '#FFFFFF' : '#000000';
        out.pi = dark ? 0.038 : 0.032;
        out.ps = 0.82;
      }
      return out;
    }
    try {
      const bb = spec.bubbleFor(value, dark);
      if (bb && bb.bg) { out.ob = bb.bg; out.oi = bb.text || '#FFFFFF'; }
    } catch {}
    const r = spec.resolve(value, dark);
    if (r.kind === 'native') {
      if (r.imageUri) {
        let u = r.imageUri;
        try { u = require('../WallpaperPicker').resolveWallpaperUri(u) || u; } catch {}
        out.u = u; out.ua = 1;
        if (r.dim > 0) out.ud = r.dim;
        return out;
      }
      const cols = Array.isArray(r.colors) && r.colors.length ? r.colors : null;
      if (r.patternMode === 'mask') {
        // escuro: preto + padrão "aceso" nas cores do tema
        out.c = '#000000';
        if (r.pattern) { out.p = _patternProp(r.pattern); out.pc = cols ? spec.averageColor(cols) : '#FFFFFF'; out.pi = r.patternIntensity || 0.55; out.ps = 1; }
        return out;
      }
      out.c = cols ? spec.averageColor(cols) : (r.baseColor || base);
      if (r.pattern) { out.p = _patternProp(r.pattern); out.pc = r.patternColor || '#000000'; out.pi = r.patternIntensity || 0.1; out.ps = 1; }
      return out;
    }
    if (r.kind === 'legacy') {
      const v = String(r.value || '');
      if (v.startsWith('grad:')) {
        try {
          const g = require('../WallpaperPicker').gradientById(v.slice(5));
          if (g && g.colors) out.c = _mix(base, spec.averageColor(g.colors), dark ? 0.32 : 0.4);
        } catch {}
        return out;
      }
      if (/^#[0-9a-f]{3,8}$/i.test(v)) { out.c = _mix(base, v, 0.15); return out; }
      let u = v;
      try { u = require('../WallpaperPicker').resolveWallpaperUri(v) || v; } catch {}
      if (u) { out.u = u; out.ua = dark ? 0.55 : 0.85; }
      return out;
    }
    return out;
  } catch {
    return null;
  }
}
