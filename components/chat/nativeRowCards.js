// components/chat/nativeRowCards.js — [2026-10-15 native-list fase 2]
//
// Cartões ricos da lista NATIVA (row.bl / row.post), montados com os MESMOS
// valores de estilo do render JS (app/chat-conversation.js renderMessage):
// localização (estática + ao vivo), contato, enquete, evento (meetup),
// playlist, cartão de chamada, chamada em JSON/texto antigo, GIF por URL,
// nota de vídeo redonda, presente, resposta a status, visualização única
// (remetente + "Aberta") e o cartão de PRÉVIA DE LINK (row.post de textos).
//
//   cardReason(item, ctx) → null (não é cartão) | '' (suportado) | 'motivo'
//   buildCard(item, row, ctx) → true quando preencheu row.bl (cartão);
//                               false = segue o caminho normal (texto pode
//                               ganhar row.post com a prévia de link).
//   runCardAction(item, action, deps) → executa o toque (part 'action').
//
// ctx.cards (montado no _nlCtx do chat-conversation):
//   { rev, bump(), isDark, colors{text,textSecondary,textTertiary,surface,
//     border,primary}, ownText, ownMeta, otherMeta, otherInk, bubbleRadius,
//     fontSize, t, now (relógio de 30 s quando há localização ao vivo),
//     liveSeen(), resolve(uri), formatLiveTimeRemaining(ts,t),
//     lp{get,set,skip,color} (cache de prévias do JS) }
// Dados assíncronos (prévia de link, "tem Chatyy?" do contato) chegam por
// caches de módulo; ao resolver chamam cards.bump() → `rev` muda → ctx muda →
// as linhas são renormalizadas e só as que mudaram vão ao nativo.
//
// Ações (`a` dos nós → onRowPress part 'action', url = ação):
//   loc · loc_stop · jloc · ct_msg · ct_inv · ct_save · ct_call · poll:<i> ·
//   rsvp:<going|maybe|not_going> · pl_edit · pl_song:<i> · call_back:<v|a> ·
//   call_join · st_open · vn_open · lp:<url>
import { Platform } from 'react-native';
import {
  vstack, hstack, zstack, text, image, avatar, loader, videoNote, icon, toArgb,
} from './nativeNodes';
import {
  IconMapPin, IconUser, IconUserPlus, IconPlus, IconPhone, IconVideo, IconCalendar, IconClock,
  IconCheckCircle, IconHelpCircle, IconBarChart, IconPlay, IconPencil, IconMusic, IconEye, IconLock,
  IconCheck, IconMic, IconImage, IconVideoNote, IconGlobe, IconDiamond,
} from '../Icons';

// ─── utilidades ─────────────────────────────────────────────────────────────
const URL_RE = /(https?:\/\/[^\s<]+)/;
const CALL_TEXT_RE = /^(Chamada de Voz|Videochamada|Voice Call|Video Call)\n/i;
const PAD = [7, 12, 7, 12]; // styles.bubble paddingTop/H/Bottom

function _tr(C, k, fb) {
  try { const v = C && C.t ? C.t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; }
}
function _own(item, ctx) {
  return String(item.sender_email || '').toLowerCase() === String(ctx.myEmail || '').toLowerCase();
}
function _json(s) {
  if (s && typeof s === 'object') return s;
  if (typeof s !== 'string') return null;
  const c = s.trim();
  if (!c || !((c.startsWith('{') || c.startsWith('[')) && (c.endsWith('}') || c.endsWith(']')))) return null;
  try { return JSON.parse(c); } catch {}
  try {
    return JSON.parse(c.replace(/^\{\s*/, '{').replace(/\s*\}$/, '}').replace(/^\[\s*/, '[').replace(/\s*\]$/, ']'));
  } catch { return null; }
}
// Largura aproximada de texto (dp) p/ escolher entre minWidth/maxWidth do JS.
function _estW(s, fs, bold) {
  const n = String(s || '').length;
  return n * fs * (bold ? 0.58 : 0.52);
}
function _clampW(min, max, ...need) {
  let w = min;
  for (const x of need) if (Number.isFinite(x) && x > w) w = x;
  return Math.round(Math.min(max, w));
}
function _isViewOnce(m) { return !!(m && (m.is_view_once || m.isViewOnce || m.view_once)); }
function _mediaAbs(u) {
  if (!u || typeof u !== 'string') return '';
  if (/^(https?:|file:|data:)/i.test(u)) return u;
  try { return require('../../services/api').getMediaUrl(u); } catch { return u; }
}
function _hm(d) {
  try {
    const x = new Date(d);
    return isNaN(x.getTime()) ? '' : x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

// ─── caches assíncronos ─────────────────────────────────────────────────────
const _lpInflight = new Set();
function _lpFor(url, C) {
  const lp = C.lp;
  if (!lp || typeof lp.get !== 'function') return null;
  if (lp.skip && lp.skip(url)) return null;
  const v = lp.get(url);
  if (v !== undefined) return v || null;
  if (_lpInflight.has(url)) return null;
  _lpInflight.add(url);
  // Mesmo debounce de 300 ms do LinkPreview JS.
  setTimeout(() => {
    let api = null;
    try { api = require('../../services/api'); api = api.default || api; } catch { api = null; }
    const done = (val) => { _lpInflight.delete(url); try { lp.set(url, val); } catch {} try { C.bump && C.bump(); } catch {} };
    if (!api || typeof api.chatLinkPreview !== 'function') { _lpInflight.delete(url); return; }
    Promise.resolve(api.chatLinkPreview(url)).then((r) => {
      if (r && r.success && r.data && (r.data.title || r.data.image)) done(r.data);
      else done(false);
    }).catch(() => done(false));
  }, 300);
  return null;
}

const _ctMap = new Map(); // email|phone → { loading, has, email }
function _ctFor(email, phone, C) {
  const key = String(email || '') + '|' + String(phone || '');
  if (!email && !phone) return { loading: false, has: false };
  const hit = _ctMap.get(key);
  if (hit) return hit;
  const ent = { loading: true, has: false, email };
  _ctMap.set(key, ent);
  if (_ctMap.size > 400) { const k0 = _ctMap.keys().next().value; if (k0 !== key) _ctMap.delete(k0); }
  (async () => {
    let next = { loading: false, has: false, email };
    try {
      const r = await require('../../services/api').chatCheckChatyy({ email, phone });
      next = { loading: false, has: !!(r && r.data && r.data.has_chatyy), email: (r && r.data && r.data.email) || email };
    } catch {}
    _ctMap.set(key, next);
    try { C.bump && C.bump(); } catch {}
  })();
  return ent;
}

// ─── avatar (mesmo algoritmo do components/AvatarCircle.js) ────────────────
const AVATAR_GRADIENTS = [
  ['#5C5C5C', '#333333'], ['#636363', '#3A3A3A'], ['#545454', '#2C2C2C'], ['#6A6A6A', '#404040'],
  ['#4D4D4D', '#262626'], ['#5F5F5F', '#363636'], ['#575757', '#303030'], ['#666666', '#3D3D3D'],
];
function _hashInt(s) { let h = 0; const str = s || ''; for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h); return Math.abs(h); }
function _initials(name, email) {
  const looks = (s) => typeof s === 'string' && /@/.test(s);
  let src = '';
  if (name && typeof name === 'string' && name.trim() && !looks(name)) src = name.trim();
  else if (typeof email === 'string' && email.includes('@')) src = email.split('@')[0];
  else if (name && typeof name === 'string' && name.trim()) src = name.trim();
  if (!src) return '';
  const parts = src.split(/[\s._\-]+/).filter(Boolean);
  if (parts.length >= 2) return ((parts[0][0] || '') + (parts[1][0] || '')).toUpperCase();
  return ((parts[0] || '').slice(0, 2) || '').toUpperCase();
}
function _avatarNode(name, email, size) {
  const seed = String(name || email || '').toLowerCase();
  const [c1, c2] = AVATAR_GRADIENTS[_hashInt(seed) % AVATAR_GRADIENTS.length];
  let u = '';
  try {
    if (typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.toLowerCase() !== 'ai@chatyy.com.br') {
      const remote = require('../../services/avatar').buildAvatarUrl(email, { name });
      let disk = null;
      try { disk = require('../../services/avatarCache').getCachedAvatarUriOrNull(remote); } catch {}
      u = disk || remote || '';
    }
  } catch { u = ''; }
  return avatar({ s: size, u: u || undefined, tx: _initials(name, email), bg: c1, bg2: toArgb(c2), c: '#ffffff', fs: Math.round(size * 0.38) });
}

// ─── arte do presente (LiveGiftGlyph → paths; degradês viram prata chapada) ─
const _giftMemo = new Map();
function _giftGlyph(iconName, size) {
  const k = String(iconName || 'gift');
  let ent = _giftMemo.get(k);
  if (!ent) {
    const ps = [];
    let vb = 48;
    try {
      const G = require('../live/LiveGiftGlyph').default;
      const fn = G && typeof G === 'object' && G.type ? G.type : G;
      const el = typeof fn === 'function' ? fn({ icon: iconName, size: 48 }) : null;
      const paint = (v) => {
        if (v === undefined || v === null) return undefined;
        if (v === 'none' || v === 'transparent') return 0;
        const s = String(v);
        if (s.startsWith('url(')) return /g\)$/.test(s) ? 0 : toArgb('#d9d9d9'); // ...s = prata, ...g = brilho
        return toArgb(s);
      };
      const shapeD = (name, p) => {
        const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
        if (name === 'Circle' || name === 'Ellipse') {
          const cx = n(p.cx); const cy = n(p.cy); const rx = name === 'Circle' ? n(p.r) : n(p.rx); const ry = name === 'Circle' ? n(p.r) : n(p.ry);
          return rx > 0 && ry > 0 ? `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z` : '';
        }
        if (name === 'Line') return `M${n(p.x1)} ${n(p.y1)}L${n(p.x2)} ${n(p.y2)}`;
        if (name === 'Rect') { const x = n(p.x); const y = n(p.y); const w = n(p.width); const h = n(p.height); return `M${x} ${y}H${x + w}V${y + h}H${x}Z`; }
        const pts = String(p.points || '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
        if (pts.length < 4) return '';
        let d = `M${pts[0]} ${pts[1]}`;
        for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
        return name === 'Polygon' ? d + 'Z' : d;
      };
      const walk = (node, inh, depth) => {
        if (!node || depth > 10) return;
        if (Array.isArray(node)) { for (const c of node) walk(c, inh, depth + 1); return; }
        if (typeof node !== 'object' || !node.props) return;
        let ty = node.type; if (ty && typeof ty === 'object' && ty.type) ty = ty.type;
        const name = ty ? (typeof ty === 'string' ? ty : (ty.displayName || ty.name || '')) : '';
        const p = node.props;
        if (['Path', 'Line', 'Polyline', 'Polygon', 'Circle', 'Ellipse', 'Rect'].includes(name)) {
          const d = name === 'Path' ? String(p.d || '') : shapeD(name, p);
          if (!d) return;
          const f = paint(p.fill); const kk = paint(p.stroke);
          const e = { d };
          const fill = f !== undefined ? f : inh.fill;
          const stroke = kk !== undefined ? kk : inh.stroke;
          const sw = p.strokeWidth != null ? Number(p.strokeWidth) : inh.sw;
          if (fill) e.f = fill;
          if (stroke && sw > 0) { e.k = stroke; e.w = sw; }
          if (e.f || e.k) ps.push(e);
          return;
        }
        if (name === 'Svg' && p.viewBox) { const a = String(p.viewBox).split(/[\s,]+/).map(Number); if (a[2] > 0) vb = a[2]; }
        if (name === 'Defs' || name === 'LinearGradient' || name === 'RadialGradient') return;
        const next = { ...inh };
        if (p.fill !== undefined) next.fill = paint(p.fill);
        if (p.stroke !== undefined) next.stroke = paint(p.stroke);
        if (p.strokeWidth !== undefined) next.sw = Number(p.strokeWidth);
        walk(p.children, next, depth + 1);
      };
      walk(el, { fill: toArgb('#000000'), stroke: 0, sw: 1 }, 0);
    } catch {}
    ent = { ps, vb };
    _giftMemo.set(k, ent);
  }
  if (!ent.ps.length) return null;
  return { t: 'ic', s: size, vb: ent.vb, ps: ent.ps };
}

// ─── parse por tipo ─────────────────────────────────────────────────────────
function _poll(m) {
  let poll = m.poll;
  if (poll && !Array.isArray(poll.vote_counts) && Array.isArray(poll.votes)) {
    poll = { ...poll, vote_counts: poll.votes, total_votes: typeof poll.total_votes === 'number' ? poll.total_votes : poll.votes.reduce((a, v) => a + (v || 0), 0) };
  }
  if (!poll && typeof m.content === 'string') {
    try {
      const p = JSON.parse(m.content.trim());
      if (p && p.question && Array.isArray(p.options)) {
        poll = {
          ...p, id: m.id,
          vote_counts: Array.isArray(p.votes) ? p.votes : [],
          total_votes: Array.isArray(p.votes) ? p.votes.reduce((a, b) => a + (b || 0), 0) : 0,
          my_votes: Array.isArray(p.my_votes) ? p.my_votes : [],
        };
      }
    } catch {}
  }
  return poll || null;
}

function _loc(m) {
  let loc = {};
  try {
    loc = typeof m.content === 'string' ? JSON.parse(m.content) : (m.content && typeof m.content === 'object' ? m.content : {});
  } catch { loc = {}; }
  if (!loc || typeof loc !== 'object') loc = {};
  const lat = loc.latitude ?? loc.lat ?? m.latitude ?? null;
  const lng = loc.longitude ?? loc.lng ?? m.longitude ?? null;
  const rawAddr = loc.address ?? loc.label ?? m.address ?? '';
  const addr = typeof rawAddr === 'string' ? rawAddr : '';
  const isLive = !!(loc.live || m.live);
  const until = loc.live_until || m.live_until || null;
  const nowSec = Date.now() / 1000;
  const unlimited = !!loc.is_unlimited || !!m.is_unlimited || (isLive && until && (Number(until) - nowSec) > 365 * 24 * 3600);
  const expired = isLive && !unlimited && until && nowSec >= until;
  const active = isLive && (unlimited || (until && nowSec < until));
  return { lat, lng, addr, isLive, until, unlimited, expired: !!expired, active: !!active };
}

function _contact(m, C) {
  let ct = {};
  if (m.contact && typeof m.contact === 'object') ct = m.contact;
  else {
    const raw = m.content;
    if (raw && typeof raw === 'string') {
      const tr = raw.trim();
      if (/^BEGIN:VCARD/i.test(tr)) {
        try {
          const card = { name: '', phone: '', email: '' };
          for (const ln of tr.split(/\r?\n/)) {
            if (/^FN[:;]/i.test(ln)) card.name = ln.replace(/^FN[^:]*:/i, '').trim();
            else if (!card.name && /^N[:;]/i.test(ln)) card.name = ln.replace(/^N[^:]*:/i, '').split(';').filter(Boolean).reverse().join(' ').trim();
            else if (!card.phone && /^TEL/i.test(ln)) card.phone = ln.replace(/^TEL[^:]*:/i, '').trim();
            else if (!card.email && /^EMAIL/i.test(ln)) card.email = ln.replace(/^EMAIL[^:]*:/i, '').trim();
          }
          ct = card;
        } catch {}
      } else { try { ct = JSON.parse(raw); } catch { ct = {}; } }
    } else if (raw && typeof raw === 'object') ct = raw;
  }
  if (!ct || typeof ct !== 'object') ct = {};
  const name = String(ct.name || ct.phone || ct.email || _tr(C, 'chatConv.contact', 'Contato'));
  return { name, phone: ct.phone ? String(ct.phone) : '', email: ct.email ? String(ct.email) : '' };
}

const FLAGS = { '1':'🇺🇸','7':'🇷🇺','20':'🇪🇬','27':'🇿🇦','30':'🇬🇷','31':'🇳🇱','32':'🇧🇪','33':'🇫🇷','34':'🇪🇸','36':'🇭🇺','39':'🇮🇹','40':'🇷🇴','41':'🇨🇭','43':'🇦🇹','44':'🇬🇧','45':'🇩🇰','46':'🇸🇪','47':'🇳🇴','48':'🇵🇱','49':'🇩🇪','51':'🇵🇪','52':'🇲🇽','53':'🇨🇺','54':'🇦🇷','55':'🇧🇷','56':'🇨🇱','57':'🇨🇴','58':'🇻🇪','60':'🇲🇾','61':'🇦🇺','62':'🇮🇩','63':'🇵🇭','64':'🇳🇿','65':'🇸🇬','66':'🇹🇭','81':'🇯🇵','82':'🇰🇷','84':'🇻🇳','86':'🇨🇳','90':'🇹🇷','91':'🇮🇳','92':'🇵🇰','94':'🇱🇰','98':'🇮🇷','212':'🇲🇦','234':'🇳🇬','351':'🇵🇹','353':'🇮🇪','358':'🇫🇮','380':'🇺🇦','420':'🇨🇿','852':'🇭🇰','886':'🇹🇼','971':'🇦🇪','972':'🇮🇱' };
function _flag(p) {
  const d = (p || '').replace(/\D/g, '');
  if (!d) return '';
  for (const len of [3, 2, 1]) { const k = d.slice(0, len); if (FLAGS[k]) return FLAGS[k]; }
  return '';
}
function _prettyPhone(p) {
  const raw = (p || '').trim();
  if (!raw) return '';
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+55') || (d.length === 13 && d.startsWith('55'))) {
    const r = d.slice(2);
    if (r.length === 11) return `+55 (${r.slice(0, 2)}) ${r.slice(2, 7)}-${r.slice(7)}`;
    if (r.length === 10) return `+55 (${r.slice(0, 2)}) ${r.slice(2, 6)}-${r.slice(6)}`;
  }
  return raw;
}

function _viewOnce(m, ctx) {
  const fileUrl = m.file_url || '';
  const isAudio = (m.type === 'audio' || m.type === 'voice') || /\.(m4a|opus|ogg|mp3|aac|wav)(\?|$)/i.test(String(fileUrl));
  const isVideo = !isAudio && (m.type === 'video' || /\.(mp4|mov|webm|mkv|avi|m4v|3gp)(\?|$)/i.test(String(fileUrl)));
  let vb = m.viewed_by;
  if (typeof vb === 'string') { try { vb = JSON.parse(vb); } catch { vb = []; } }
  if (!Array.isArray(vb)) vb = [];
  const me = String(ctx.myEmail || '').toLowerCase();
  const hasMe = !!me && vb.some(e => String(e || '').toLowerCase() === me);
  return { isAudio, isVideo, anyViewed: vb.length > 0, locked: !!m.expired_at || hasMe };
}

/** Tipo de cartão da linha (ou null). */
function cardKind(item, ctx) {
  if (!item || item._type) return null;
  if (item.deleted_at) return null;
  if (_isViewOnce(item)) return 'vo';
  if (ctx.isVideoNote && ctx.isVideoNote(item)) return 'vn';
  const type = item.type || 'text';
  switch (type) {
    case 'location': case 'contact': case 'poll': case 'meetup': case 'playlist':
    case 'call_card': case 'gift': case 'status_reply':
      return type;
    default: break;
  }
  if (type !== 'text') return null;
  const c = typeof item.content === 'string' ? item.content : '';
  const ct = c.trim();
  if (!ct) return null;
  const j = (ct.startsWith('{') || ct.startsWith('[')) ? _json(ct) : null;
  if (j && typeof j === 'object') {
    if (j.call_type) return 'jcall';
    if (j.playlist_name) return 'jpl';
    if (j.latitude !== undefined || j.longitude !== undefined) return 'jloc';
    return null;
  }
  const tenor = /^[a-z0-9]+\/[a-z0-9\-]+\.gif$/i.test(ct);
  if ((tenor || /^https?:\/\//.test(ct)) && (ct.includes('tenor.com') || ct.includes('giphy.com') || ct.includes('media.tenor.com') || /\.gif(\?.*)?$/i.test(ct))) return 'giftext';
  if (CALL_TEXT_RE.test(c)) return 'calltext';
  return null;
}

// ─── cardReason ─────────────────────────────────────────────────────────────
export function cardReason(item, ctx) {
  const k = cardKind(item, ctx || {});
  if (!k) return null;
  const C = ctx && ctx.cards;
  if (!C) return 'cards-ctx';
  if (item._blurred) return 'blurred';
  if (item._searchTerm) return 'search';
  if (item._filtered && item._hidden) return 'filtered';
  switch (k) {
    case 'vo': {
      const own = _own(item, ctx);
      if (own) return '';
      return _viewOnce(item, ctx).locked ? '' : 'vo-unviewed'; // receptor sem ver: viewer próprio do JS
    }
    case 'vn': return (item.file_url || item.content || item._localUri) ? '' : 'vn-nourl';
    case 'poll': return _poll(item) ? '' : 'poll-raw';
    case 'meetup': case 'playlist': case 'call_card': return _json(item.content) ? '' : k + '-raw';
    case 'location': return '';
    default: return '';
  }
}

// ─── construtores por tipo ─────────────────────────────────────────────────
function _palette(own, C) {
  const col = C.colors || {};
  return {
    col,
    dark: !!C.isDark,
    text: own ? C.ownText : col.text,
    meta: own ? C.ownMeta : C.otherMeta,
  };
}

function buildLocation(m, row, ctx, C, own) {
  const L = _loc(m);
  const P = _palette(own, C);
  const isDark = P.dark;
  const CARD_W = 260;
  const MAP_H = Platform.OS === 'android' ? 140 : 160;
  const mapR = Math.max(4, (Number(C.bubbleRadius) || 18) - 4);
  const ph = isDark ? '#2C2C2E' : '#E5E5EA';
  const hasCoords = L.lat != null && L.lng != null;
  if (L.active) { try { C.liveSeen && C.liveSeen(); } catch {} }
  let map;
  if (hasCoords) {
    let u = '';
    try { const s = require('../BoraMap').chatyyStaticMap(L.lat, L.lng, { zoom: 15, dark: isDark, pin: !L.active }); u = s ? s.api : ''; } catch {}
    const kids = [image(u, { w: -1, h: MAP_H, fit: 'cover', bg: ph })];
    if (L.active) {
      const pc = isDark ? '#FFFFFF' : '#111111';
      kids.push(vstack([], { pos: 'c', w: 16, h: 16, r: 8, bg: pc, bc: '#FFFFFF', bw: 2.5 }));
      kids.push(hstack([
        vstack([], { w: 6, h: 6, r: 3, bg: '#FFFFFF' }),
        text(_tr(C, 'chatConv.liveBadge', 'AO VIVO'), { fs: 10, fw: 800, c: '#FFFFFF', ls: 0.3 }),
      ], { pos: 'tl', m: [8, 0, 0, 8], bg: 'rgba(0,0,0,0.78)', r: 12, p: [3, 8, 3, 8], g: 5, al: 'c' }));
      if (L.until) {
        const now = Math.floor((Number(C.now) || Date.now()) / 1000);
        const rem = Number(L.until) - now;
        if (rem > 0) {
          let label;
          if (L.unlimited) label = `∞ ${_tr(C, 'snapmap.alwaysOn', 'sempre ativo')}`;
          else if (rem < 3600) { const mm = Math.floor(rem / 60); const ss = rem % 60; label = `${_tr(C, 'chatConv.liveEndsIn', 'Acaba em')} ${mm}m${String(ss).padStart(2, '0')}s`; }
          else {
            const e = new Date(Number(L.until) * 1000);
            label = `${_tr(C, 'chatConv.liveSharingUntil', 'Compartilhamento ao vivo até')} ${String(e.getHours()).padStart(2, '0')}:${String(e.getMinutes()).padStart(2, '0')}`;
          }
          kids.push(vstack([text(label, { fs: 11, fw: 600, c: '#FFFFFF', ta: 'c', ls: 0.2, ml: 1 })], { pos: 'b', w: -1, bg: 'rgba(0,0,0,0.55)', p: [4, 8, 4, 8] }));
        }
      }
    }
    if (L.expired) {
      kids.push(vstack([text(_tr(C, 'chatConv.liveEndedBadge', 'ENCERRADA'), { fs: 10, fw: 800, c: '#FFFFFF', ls: 0.3 })], { pos: 'tl', m: [8, 0, 0, 8], bg: 'rgba(60,60,67,0.85)', r: 12, p: [3, 8, 3, 8] }));
    }
    map = zstack(kids, { w: -1, h: MAP_H, r: mapR, bg: ph });
  } else {
    map = vstack([icon(IconMapPin, { s: 32, c: '#8E8E93' })], { w: -1, h: MAP_H, r: mapR, bg: ph, al: 'c', jc: 'c' });
  }
  const title = L.expired ? _tr(C, 'chatConv.liveLocationEnded', 'Localização ao vivo encerrada')
    : (L.active ? _tr(C, 'chatConv.liveLocation', 'Localização ao vivo') : (L.addr || _tr(C, 'chatConv.location', 'Localização')));
  let sub;
  if (L.expired) sub = _tr(C, 'chatConv.tapToSeeLastLocation', 'Toque para ver última localização');
  else if (L.active) {
    const rest = L.unlimited ? ('∞ ' + _tr(C, 'snapmap.alwaysOn', 'sempre ativo')) : (C.formatLiveTimeRemaining ? C.formatLiveTimeRemaining(L.until, C.t) : '');
    sub = `${_tr(C, 'chatConv.sharingLive', 'Compartilhando')} • ${rest}`;
  } else sub = _tr(C, 'chatConv.tapToOpenMap', 'Toque para abrir no mapa');
  const footer = hstack([
    vstack([
      text(title, { fs: 14, fw: 600, c: P.text, ml: 1 }),
      text(sub, { fs: 12, c: P.meta, ml: 1, m: [2, 0, 0, 0] }),
    ], { fl: 1 }),
    (L.active && own) ? vstack([text(_tr(C, 'chatConv.stopSharing', 'Parar'), { fs: 12, fw: 700, c: '#111111' })], { p: [6, 12, 6, 12], r: 14, bg: '#FFFFFF', m: [0, 0, 0, 4], a: 'loc_stop' }) : null,
  ], { p: [7, 6, 0, 6], g: 8, al: 'c' });
  row.bl = [vstack([map, footer], { w: CARD_W, a: 'loc' })];
  row.cw = CARD_W;
  row.pad = [4, 4, 5, 4];
  row.mp = 'below';
}

function buildJsonLocation(j, row, C) {
  const col = C.colors || {};
  const label = String(j.label || j.address || 'Localização');
  const sub = _tr(C, 'chatConv.tapToOpenMap', 'Toque para abrir no mapa');
  const w = _clampW(200, 280, 24 + 44 + 8 + Math.max(_estW(label, 13, true), _estW(sub, 11)));
  row.bl = [vstack([
    hstack([
      vstack([icon(IconMapPin, { s: 22, c: col.text })], { w: 44, h: 44, r: 12, bg: C.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)', al: 'c', jc: 'c' }),
      vstack([
        text(label, { fs: 13, fw: 600, c: col.text, m: [0, 0, 2, 0] }),
        text(sub, { fs: 11, c: col.textSecondary, fw: 500 }),
      ], { fl: 1 }),
    ], { g: 8, al: 'c' }),
  ], { w, bg: col.surface, r: 12, p: [10, 12, 10, 12], a: 'jloc' })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

function buildContact(m, row, ctx, C, own) {
  const ct = _contact(m, C);
  const P = _palette(own, C);
  const col = P.col; const isDark = P.dark;
  const flag = _flag(ct.phone);
  const pretty = _prettyPhone(ct.phone);
  const cardBg = own ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.18)') : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)');
  const dividerColor = own ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17, 17, 17,0.18)') : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)');
  const accent = own ? C.ownText : C.otherInk;
  const info = [text(ct.name, { fs: 16, fw: 700, c: own ? C.ownText : col.text, lh: 20, ml: 2 })];
  if (pretty) {
    info.push(hstack([
      flag ? text(flag, { fs: 14 }) : null,
      text(pretty, { fs: 13.5, c: own ? C.ownMeta : col.textSecondary, ml: 1, fl: 1 }),
    ], { g: 6, m: [4, 0, 0, 0], al: 'c' }));
  }
  if (ct.email) info.push(text(ct.email, { fs: 12.5, c: own ? C.ownMeta : C.otherMeta, ml: 1, m: [pretty ? 2 : 4, 0, 0, 0] }));
  const chk = _ctFor(ct.email, ct.phone, C);
  const btn = (kids, a) => hstack(kids, { fl: 1, jc: 'c', al: 'c', g: 6, p: [11, 0, 11, 0], a });
  const vdiv = () => vstack([], { w: 0.5, h: 40, bg: dividerColor });
  const first = chk.loading
    ? btn([loader({ s: 20, c: accent })], undefined)
    : (chk.has
      ? btn([icon(IconUser, { s: 14, c: accent }), text(_tr(C, 'chatConv.sendMessage', 'Mensagem'), { fs: 13, fw: 600, c: accent })], 'ct_msg')
      : btn([icon(IconUserPlus, { s: 14, c: accent }), text(_tr(C, 'chat.invite', 'Convidar'), { fs: 13, fw: 600, c: accent })], 'ct_inv'));
  const actions = [first, vdiv(), btn([icon(IconPlus, { s: 14, c: accent }), text(_tr(C, 'chatConv.addContact', 'Adicionar'), { fs: 13, fw: 600, c: accent })], 'ct_save')];
  if (ct.phone) actions.push(vdiv(), btn([icon(IconPhone, { s: 14, c: accent }), text(_tr(C, 'chatConv.callContact', 'Ligar'), { fs: 13, fw: 600, c: accent })], 'ct_call'));
  const w = _clampW(250, 300, 12 + 56 + 12 + 12 + Math.max(Math.min(_estW(ct.name, 16, true), 180), _estW(pretty, 13.5) + (flag ? 24 : 0), _estW(ct.email, 12.5)));
  row.bl = [vstack([
    hstack([_avatarNode(ct.name, ct.email, 56), vstack(info, { fl: 1 })], { g: 12, p: [12, 12, 10, 12], al: 'c' }),
    vstack([], { w: -1, h: 0.5, bg: dividerColor }),
    hstack(actions, { w: -1, al: 'c' }),
  ], { w, r: 14, bg: cardBg })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

function buildPoll(m, row, ctx, C, own) {
  const poll = _poll(m);
  const isDark = !!C.isDark;
  const fs = Number(C.fontSize) || 16;
  const opts = Array.isArray(poll.options) ? poll.options : [];
  const cardBg = isDark ? '#1c1c1e' : '#ffffff';
  const cardBorder = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';
  const cardText = isDark ? '#f5f5f5' : '#111827';
  const cardSub = isDark ? 'rgba(255,255,255,0.55)' : '#64748b';
  const accent = isDark ? '#F5F5F7' : '#111111';
  const bgFill = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17, 17, 17,0.18)';
  const bgFillVoted = isDark ? 'rgba(255,255,255,0.22)' : 'rgba(17, 17, 17,0.42)';
  const trackBg = isDark ? 'rgba(255,255,255,0.06)' : '#f1f5f9';
  let longest = _estW(poll.question, fs, true) + 28 + 7;
  for (const o of opts) longest = Math.max(longest, _estW(o, 13, true) + 18 + 7 + 7 + 32 + 20);
  const w = _clampW(220, 280, longest + 22);
  const optW = w - 22;
  const total = Number(poll.total_votes) || 0;
  const counts = poll.vote_counts || [];
  const mine = poll.my_votes || [];
  const pcts = opts.map((_, i) => (total > 0 ? Math.round(((counts[i] || 0) / total) * 100) : 0));
  const isQuiz = !!poll.is_quiz;
  const correct = Number.isInteger(poll.correct_option) ? poll.correct_option : -1;
  const hasVoted = mine.length > 0;
  const kids = [hstack([
    vstack([icon(IconBarChart, { s: 14, c: accent })], { w: 28, h: 28, r: 14, bg: 'rgba(17, 17, 17,0.14)', al: 'c', jc: 'c' }),
    vstack([
      text(String(poll.multiple_choice ? _tr(C, 'chat.pollMultipleBadge', 'Enquete · múltipla') : _tr(C, 'chat.pollBadge', 'Enquete')).toUpperCase(), { fs: 10, fw: 700, c: cardSub, ls: 0.3, m: [0, 0, 1, 0] }),
      text(String(poll.question || ''), { fs, fw: 700, c: cardText, lh: fs + 3 }),
    ], { fl: 1 }),
  ], { g: 7, m: [0, 0, 8, 0], al: 'c' })];
  opts.forEach((opt, idx) => {
    const voted = mine.includes(idx);
    const pct = pcts[idx];
    const showQuiz = isQuiz && hasVoted && correct >= 0;
    const isCorrect = showQuiz && idx === correct;
    const isWrong = showQuiz && voted && idx !== correct;
    const green = '#10B981'; const red = '#EF4444';
    const pctW = pct > 0 ? (pct >= 100 ? 36 : 32) : 0;
    const textW = optW - 20 - 18 - 7 - (pct > 0 ? 7 + pctW : 0);
    const lines = _estW(opt, 13, voted) > textW ? 2 : 1;
    const rowH = 16 + 17 * lines;
    const circle = vstack([
      isCorrect ? text('✓', { fs: 10, fw: 800, c: '#FFFFFF' })
        : isWrong ? text('✕', { fs: 10, fw: 800, c: '#FFFFFF' })
          : voted ? text('✓', { fs: 10, fw: 800, c: isDark ? '#000000' : '#FFFFFF' }) : null,
    ], {
      w: 18, h: 18, r: 9, bw: 1.5, al: 'c', jc: 'c',
      bc: isCorrect ? green : isWrong ? red : voted ? accent : (isDark ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.18)'),
      bg: isCorrect ? green : isWrong ? red : voted ? accent : undefined,
    });
    kids.push(zstack([
      { t: 'pb', id: `p${m.id}_${idx}`, v: pct / 100, h: rowH, w: -1, r: 12, c: toArgb(voted ? bgFillVoted : bgFill), bg: toArgb(trackBg) },
      hstack([
        circle,
        text(String(opt), { fs: 13, lh: 17, c: cardText, fw: voted ? 700 : 500, ml: 2, fl: 1 }),
        pct > 0 ? text(`${pct}%`, { fs: 12, fw: 700, c: voted ? accent : cardSub, w: pctW, ta: 'r' }) : null,
      ], { pos: 'l', w: -1, h: rowH, p: [0, 10, 0, 10], g: 7, al: 'c' }),
    ], {
      m: [0, 0, 5, 0], r: 12, w: -1,
      bw: (voted || isCorrect) ? 1.5 : 1,
      bc: isCorrect ? green : isWrong ? red : voted ? accent : (own ? 'rgba(255,255,255,0.22)' : (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17, 17, 17,0.20)')),
      a: `poll:${idx}`,
    }));
  });
  if (isQuiz && hasVoted && poll.explanation) {
    kids.push(vstack([
      text(_tr(C, 'chat.quizExplanation', 'Explicação'), { fs: 11, fw: 700, c: cardSub, m: [0, 0, 2, 0] }),
      text(String(poll.explanation), { fs: 12, c: cardText, lh: 16 }),
    ], { m: [6, 0, 0, 0], p: [8, 10, 8, 10], r: 8, w: -1, bg: own ? 'rgba(255,255,255,0.12)' : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)') }));
  }
  const tv = total;
  const votesLbl = tv === 0 ? _tr(C, 'chat.pollNoVotes', 'Nenhum voto ainda') : (tv === 1 ? '1 voto' : `${tv} votos`);
  kids.push(hstack([
    text((isQuiz ? _tr(C, 'chat.quiz', 'Quiz') + ' · ' : '') + votesLbl, { fs: 11, c: cardSub, fw: 500 }),
    hasVoted ? text(`✓ ${_tr(C, 'chat.youVoted', 'Você votou')}`, { fs: 11, c: accent, fw: 600 }) : null,
  ], { jc: 'sb', al: 'c', m: [2, 0, 0, 0], w: -1 }));
  row.bl = [vstack(kids, { w, p: [10, 10, 10, 10], bg: cardBg, r: 12, bc: cardBorder, bw: 1 })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

function buildMeetup(m, row, ctx, C, own) {
  const mt = _json(m.content) || {};
  const P = _palette(own, C); const col = P.col; const isDark = P.dark;
  const rs = mt.rsvp || {};
  const vals = Object.values(rs);
  const going = vals.filter(v => v === 'going').length;
  const maybe = vals.filter(v => v === 'maybe').length;
  const my = rs[ctx.myEmail] || null;
  const d = new Date(mt.datetime);
  let dateStr = mt.datetime;
  try { if (!isNaN(d.getTime())) dateStr = d.toLocaleString(_tr(C, '_locale', '') || undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch {}
  const total = going + maybe;
  const past = !isNaN(d.getTime()) && d.getTime() < Date.now();
  const ic = past ? '#6b7280' : '#111111';
  const w = _clampW(240, 280, 24 + 36 + 8 + Math.min(_estW(mt.title, 14, true), 200), 20 + 20 + _estW(dateStr, 12.5, true));
  const body = [
    hstack([icon(IconClock, { s: 14, c: ic }), text(String(dateStr || ''), { fs: 12.5, fw: 600, c: own ? C.ownText : col.text })], { g: 6, m: [0, 0, 4, 0], al: 'c' }),
  ];
  if (mt.location) body.push(hstack([icon(IconMapPin, { s: 14, c: ic }), text(String(mt.location), { fs: 12, c: own ? C.ownMeta : col.textSecondary, fl: 1, ml: 2 })], { g: 6, m: [0, 0, 4, 0], al: 'c' }));
  if (mt.description) body.push(text(String(mt.description), { fs: 12, c: own ? C.ownMeta : col.textSecondary, m: [2, 0, 4, 0], ml: 3 }));
  body.push(hstack([
    hstack([icon(IconCheckCircle, { s: 12, c: own ? C.ownText : col.text }), text(`${going} ${_tr(C, 'chatConv.going', 'vão')}`, { fs: 11, fw: 700, c: own ? C.ownText : col.text })], { g: 4, al: 'c' }),
    maybe > 0 ? hstack([icon(IconHelpCircle, { s: 12, c: own ? C.ownMeta : col.textSecondary }), text(`${maybe} ${_tr(C, 'chatConv.maybe', 'talvez')}`, { fs: 11, fw: 600, c: own ? C.ownMeta : col.textSecondary })], { g: 4, al: 'c' }) : null,
    total > 0 ? { t: 'sp', fl: 1 } : null,
    total > 0 ? text(`${total} ${total === 1 ? _tr(C, 'chatConv.attendee', 'participante') : _tr(C, 'chatConv.attendees', 'participantes')}`, { fs: 10, c: own ? C.ownMeta : C.otherMeta }) : null,
  ], { m: [4, 0, 8, 0], g: 12, al: 'c', w: -1 }));
  const labels = { going: _tr(C, 'chatConv.imGoing', 'Vou!'), maybe: _tr(C, 'chatConv.imMaybe', 'Talvez'), not_going: _tr(C, 'chatConv.imNotGoing', 'Não vou') };
  const act = { going: '#22c55e', maybe: '#f59e0b', not_going: '#ef4444' };
  body.push(hstack(['going', 'maybe', 'not_going'].map((s) => {
    const on = my === s;
    return vstack([text(labels[s], { fs: 12, c: on ? '#FFFFFF' : (own ? C.ownText : col.text), fw: on ? 700 : 500 })], {
      fl: 1, p: [7, 0, 7, 0], r: 8, al: 'c', bg: on ? act[s] : undefined,
      bw: on ? 0 : 1, bc: own ? 'rgba(255,255,255,0.15)' : ((col.border || '#E5E5EA') + '60'),
      a: `rsvp:${s}`,
    });
  }), { g: 6, w: -1 }));
  row.bl = [vstack([
    hstack([
      vstack([icon(IconCalendar, { s: 18, c: '#FFFFFF' })], { w: 36, h: 36, r: 10, bg: 'rgba(255,255,255,0.2)', al: 'c', jc: 'c' }),
      vstack([
        text(String(mt.title || ''), { fw: 700, fs: 14, c: '#FFFFFF', ml: 2 }),
        past ? text(_tr(C, 'chatConv.eventPast', 'Evento encerrado'), { fs: 10, c: 'rgba(255,255,255,0.75)', fw: 600 }) : null,
      ], { fl: 1 }),
    ], { w: -1, bg: past ? '#6b7280' : '#111111', p: [8, 12, 8, 12], g: 8, al: 'c' }),
    vstack(body, { w: -1, p: 10, bg: own ? 'rgba(255,255,255,0.08)' : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)') }),
  ], { w, r: 12, m: [1, 0, 1, 0] })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

function buildPlaylist(m, row, ctx, C) {
  const pl = _json(m.content) || {};
  const isDark = !!C.isDark;
  const songs = Array.isArray(pl.songs) ? pl.songs : [];
  const txt = isDark ? '#f5f5f5' : '#111827';
  const sub = isDark ? 'rgba(255,255,255,0.55)' : '#64748b';
  const ink = isDark ? 'rgba(255,255,255,0.7)' : '#111111';
  const subLine = `${songs.length} ${songs.length === 1 ? _tr(C, 'chatConv.song', 'música') : _tr(C, 'chatConv.songs', 'músicas')} · ${_tr(C, 'chatConv.by', 'por')} ${pl.created_by_name || ''}`;
  let need = 20 + 38 + Math.max(_estW(pl.playlist_name, 14, true), _estW(subLine, 10));
  for (const s of songs.slice(0, 4)) need = Math.max(need, 20 + 22 + 18 + _estW(s && s.title, 12));
  const w = _clampW(210, 270, need);
  const kids = [hstack([
    vstack([text('🎵', { fs: 15 })], { w: 30, h: 30, r: 8, bg: 'rgba(17, 17, 17,0.14)', al: 'c', jc: 'c', m: [0, 8, 0, 0] }),
    vstack([text(String(pl.playlist_name || ''), { fw: 700, fs: 14, c: txt, ml: 1 }), text(subLine, { fs: 10, c: sub })], { fl: 1 }),
  ], { m: [0, 0, 6, 0], al: 'c' })];
  songs.slice(0, 4).forEach((song, idx) => {
    const playable = song && song.url && /^https?:\/\//i.test(song.url);
    kids.push(hstack([
      text(String(idx + 1), { fs: 11, c: sub, w: 16, ta: 'r' }),
      vstack([
        text(String((song && song.title) || ''), { fs: 12, c: txt, fw: 500, ml: 1 }),
        song && song.artist ? text(String(song.artist), { fs: 10, c: sub, ml: 1 }) : null,
      ], { fl: 1 }),
      playable ? vstack([icon(IconPlay, { s: 12, c: isDark ? '#f5f5f5' : '#111111' })], { p: 3, a: `pl_song:${idx}` }) : null,
    ], { p: [3, 0, 3, 0], g: 6, al: 'c', w: -1 }));
  });
  if (songs.length > 4) kids.push(text(`+${songs.length - 4} ${_tr(C, 'chatConv.moreSongs', 'mais')}`, { fs: 10, c: sub, m: [3, 0, 0, 0], ta: 'c', w: -1 }));
  if (songs.length === 0) kids.push(text(_tr(C, 'chatConv.emptyPlaylist', 'Toque pra adicionar músicas'), { fs: 11, c: sub, it: 1, ta: 'c', p: [6, 0, 6, 0], w: -1 }));
  const foot = m._pending
    ? [loader({ s: 12, c: ink }), text(m._plProgress ? `${_tr(C, 'chatConv.playlistAdding', 'Adicionando')} ${m._plProgress}` : _tr(C, 'chatConv.playlistCreating', 'Criando playlist...'), { fs: 10, c: ink, fw: 600 })]
    : [icon(IconPencil, { s: 11, c: ink }), text(_tr(C, 'chatConv.tapToEdit', 'Toque pra editar'), { fs: 10, c: ink, fw: 600 })];
  kids.push(vstack([], { w: -1, h: 0.5, bg: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)', m: [6, 0, 0, 0] }));
  kids.push(hstack(foot, { p: [6, 0, 0, 0], jc: 'c', al: 'c', g: 4, w: -1 }));
  row.bl = [vstack(kids, { w, p: 10, r: 12, bg: isDark ? '#1c1c1e' : '#ffffff', bw: 1, bc: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)', a: 'pl_edit' })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

function buildJsonPlaylist(j, row, C) {
  const col = C.colors || {};
  const n = (j.songs || []).length;
  const prim = col.primary || '#111111';
  const sub = `${n} ${n === 1 ? 'música' : 'músicas'}`;
  const w = _clampW(240, 300, 24 + 44 + 8 + Math.max(_estW(j.playlist_name, 13, true), _estW(sub, 11)));
  row.bl = [vstack([hstack([
    vstack([icon(IconMusic, { s: 22, c: prim })], { w: 44, h: 44, r: 12, bg: /^#[0-9a-f]{6}$/i.test(prim) ? prim + '20' : 'rgba(17,17,17,0.12)', al: 'c', jc: 'c' }),
    vstack([text(String(j.playlist_name || ''), { fs: 13, fw: 600, c: col.text, m: [0, 0, 2, 0] }), text(sub, { fs: 11, c: col.textTertiary })], { fl: 1 }),
  ], { g: 8, al: 'c' })], { w, bg: col.surface, r: 12, p: [10, 12, 10, 12], g: 8 })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

function buildCallCard(m, row, ctx, C, own) {
  const cd = _json(m.content) || {};
  const col = C.colors || {};
  const isVideo = cd.call_type === 'video';
  const missed = cd.call_status === 'missed' || cd.call_status === 'declined';
  const ds = Number(cd.duration) || 0;
  const dStr = ds > 0 ? (ds < 60 ? `${ds}s` : `${Math.floor(ds / 60)}m ${ds % 60}s`) : '';
  const title = isVideo ? _tr(C, 'call.videoCall', 'Chamada de vídeo') : _tr(C, 'call.audioCall', 'Chamada de voz');
  const prim = col.primary || '#111111';
  const btnLbl = _tr(C, 'chatConv.callButton', 'LIGAR');
  const w = _clampW(220, 280, 38 + 10 + _estW(title, 14, true) + 10 + 24 + _estW(btnLbl, 12, true));
  const Ic = isVideo ? IconVideo : IconPhone;
  row.bl = [vstack([hstack([
    vstack([icon(Ic, { s: 18, c: missed ? '#EF4444' : '#FFFFFF' })], { w: 38, h: 38, r: 19, bg: missed ? '#EF444420' : (own ? 'rgba(255,255,255,0.18)' : prim), al: 'c', jc: 'c' }),
    vstack([
      text(title, { fs: 14, fw: 600, c: own ? '#FFFFFF' : col.text }),
      missed ? text(_tr(C, 'chatConv.missedCall', 'Perdida'), { fs: 12, c: '#EF4444', fw: 600, m: [2, 0, 0, 0] })
        : (dStr ? text(dStr, { fs: 12, c: own ? 'rgba(255,255,255,0.6)' : col.textTertiary, m: [2, 0, 0, 0] }) : null),
    ], { fl: 1 }),
    vstack([text(btnLbl, { fs: 12, fw: 700, c: own ? '#FFFFFF' : C.otherInk })], { p: [6, 12, 6, 12], r: 14, bg: own ? 'rgba(255,255,255,0.2)' : (/^#[0-9a-f]{6}$/i.test(prim) ? prim + '18' : 'rgba(17,17,17,0.09)'), a: `call_back:${isVideo ? 'v' : 'a'}` }),
  ], { g: 10, al: 'c', w: -1 })], { w })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

function buildJsonCall(j, row, ctx, C) {
  const col = C.colors || {};
  const isVideo = j.call_type === 'video';
  const caller = j.caller_email === ctx.myEmail;
  const label = isVideo ? (caller ? _tr(C, 'call.videoCall', 'Videochamada') : _tr(C, 'call.incomingVideo', 'Videochamada recebida'))
    : (caller ? _tr(C, 'call.audioCall', 'Chamada de voz') : _tr(C, 'call.incomingAudio', 'Chamada recebida'));
  const tm = j.started_at ? _hm(j.started_at) : '';
  row.bl = [vstack([hstack([
    vstack([icon(isVideo ? IconVideo : IconPhone, { s: 16, c: col.text })], { w: 32, h: 32, r: 16, bg: C.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)', al: 'c', jc: 'c' }),
    vstack([text(label, { fs: 13, fw: 600, c: col.text }), tm ? text(tm, { fs: 11, c: col.textTertiary }) : null]),
  ], { g: 8, p: [2, 0, 2, 0], al: 'c' })], { m: [8, 0, 8, 0], bg: col.surface, r: 12, p: [8, 12, 8, 12] })];
  row.pad = PAD; row.mp = 'below';
}

function buildCallText(m, row, C, own) {
  const col = C.colors || {};
  const c = String(m.content || '');
  const isVideo = /^(Videochamada|Video Call)/i.test(c);
  row.bl = [hstack([
    vstack([icon(isVideo ? IconVideo : IconPhone, { s: 16, c: own ? C.ownText : col.text })], { w: 32, h: 32, r: 16, bg: own ? 'rgba(255,255,255,0.15)' : (C.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'), al: 'c', jc: 'c' }),
    vstack([
      text(isVideo ? _tr(C, 'call.videoCall', 'Videochamada') : _tr(C, 'call.audioCall', 'Chamada de voz'), { fs: 13, fw: 600, c: own ? C.ownText : col.text }),
      text(_tr(C, 'chatConv.tapToJoin', 'Toque para entrar'), { fs: 11, c: own ? C.ownMeta : C.otherMeta }),
    ]),
  ], { g: 8, p: [2, 0, 2, 0], al: 'c', a: 'call_join' })];
  row.pad = PAD; row.mp = 'below';
}

function buildGifText(m, row) {
  const ct = String(m.content || '').trim();
  const tenor = /^[a-z0-9]+\/[a-z0-9\-]+\.gif$/i.test(ct);
  row.bl = [image(tenor ? `https://media.tenor.com/${ct}` : ct, { w: 200, h: 200, r: 16, fit: 'contain' })];
  row.cw = 200; row.pad = PAD; row.mp = 'below';
}

function buildVideoNote(m, row, ctx, C) {
  const raw = m.file_url || m.content;
  let u = '';
  try { u = (C.resolve ? C.resolve(raw) : raw) || ''; } catch { u = raw || ''; }
  if (m._localUri && !u) u = m._localUri;
  let iv = null;
  try { iv = m.image_variants ? (typeof m.image_variants === 'string' ? JSON.parse(m.image_variants) : m.image_variants) : null; } catch { iv = null; }
  let po = m._posterUri || m.thumbnail_url || m.poster_url || m.video_thumb || (iv && (iv.poster || iv.thumb)) || '';
  if (po && !/^(data:|file:)/.test(po)) { try { po = C.resolve ? C.resolve(po) : _mediaAbs(po); } catch {} }
  if (!po && m.thumb_b64) po = `data:image/jpeg;base64,${m.thumb_b64}`;
  const rd = Number(m.duration) || 0;
  const sec = rd >= 1000 ? Math.round(rd / 1000) : Math.round(rd);
  const durStr = sec > 0 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : '';
  const S = 240;
  const kids = [videoNote({ s: S, u, po: po || undefined, d: sec, bg: '#000000', ring: '#FFFFFF', r: -1, bw: 2, bc: C.isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)' })];
  if (durStr) {
    kids.push(hstack([icon(IconVideoNote, { s: 12, c: '#FFFFFF' }), text(durStr, { fs: 11, fw: 600, c: '#FFFFFF', m: [0, 0, 0, 4] })], {
      pos: 'bl', m: [0, 0, 6, 4], bg: 'rgba(0,0,0,0.55)', r: 11, p: [3, 8, 3, 8], al: 'c',
    }));
  }
  row.bl = [zstack(kids, { w: S, h: S, a: 'vn_open' })];
  row.cw = S; row.bare = 1; row.pad = [0, 0, 0, 0]; row.mp = 'over';
}

function buildGift(m, row, ctx, C, own) {
  let gc = null;
  try { gc = require('../gifts/giftCatalog'); } catch { gc = null; }
  const col = C.colors || {};
  const j = (gc && gc.parseGiftContent(m.content)) || {};
  const meta = gc ? gc.giftMeta(j.gift_sku || '') : { icon: 'gift', label: 'gift', diamonds: 1 };
  const ic = j.icon || meta.icon;
  const qty = Math.max(1, Number(j.quantity) || 1);
  const diamonds = Number(j.diamonds) || (Number(j.unit_diamonds) || meta.diamonds) * qty;
  const label = gc ? gc.giftLabel(C.t, ic, j.label || meta.label) : String(j.label || meta.label);
  const textColor = own ? C.ownText : col.text;
  const subColor = own ? C.ownText : (col.textSecondary || col.text);
  const head = own ? _tr(C, 'gifts.youSent', 'Você enviou um presente') : _tr(C, 'gifts.youReceived', 'Enviou um presente para você');
  const name = `${label}${qty > 1 ? `  ×${qty}` : ''}`;
  const sp = qty > 1 ? [[label.length, name.length, 1]] : undefined;
  const glyph = _giftGlyph(ic, 72);
  const cost = gc ? gc.humanizeCount(diamonds) : String(diamonds);
  row.bl = [vstack([
    vstack([glyph], { w: 96, h: 96, r: 48, bg: '#0b0b0b', al: 'c', jc: 'c', m: [0, 0, 8, 0] }),
    text(head, { fs: 12, fw: 600, c: subColor, ml: 1 }),
    text(name, { fs: 16, fw: 800, c: textColor, ml: 1, m: [2, 0, 0, 0], sp }),
    hstack([icon(IconDiamond, { s: 12, c: '#60a5fa' }), text(cost, { fs: 12, fw: 700, c: subColor })], { g: 4, al: 'c', m: [4, 0, 0, 0] }),
  ], { al: 'c', p: [8, 14, 4, 14], w: _clampW(160, 280, 28 + Math.max(96, _estW(head, 12, true), _estW(name, 16, true))) })];
  row.pad = PAD; row.mp = 'below';
}

function buildStatusReply(m, row, ctx, C, own) {
  const col = C.colors || {};
  const isDark = !!C.isDark;
  let payload = m.status_reply || _json(m.content);
  const bodyText = (s) => text(String(s || ''), { fs: 16, lh: 21, c: own ? C.ownText : col.text });
  if (!payload || !payload.status) {
    row.bl = [bodyText((payload && payload.reply_text) || _tr(C, 'status.replyToOwner', 'Resposta ao status'))];
    row.pad = PAD; row.mp = 'in';
    row.bl[0].mi = 1;
    return;
  }
  const st = payload.status;
  // [status-resposta 2026-10-15] reação (status_react) vs resposta; miniatura st.thumb > media_url;
  // thumb_b64 embutido = placeholder e fallback depois que o status expira (mídia apagada no servidor).
  const isReaction = !!payload.reaction;
  const b64 = m.thumb_b64 ? `data:image/jpeg;base64,${m.thumb_b64}` : '';
  const snippet = (st.content || '').split('\n')[0] || '';
  // own = EU mandei → "Você respondeu"; o dono do status vê "Respondeu ao seu status".
  const label = isReaction
    ? (own ? _tr(C, 'status.youReactedToStatus', 'Você reagiu ao status') : _tr(C, 'status.reactedToYourStatus', 'Reagiu ao seu status'))
    : (own ? _tr(C, 'status.replyToOwner', 'Você respondeu ao status') : _tr(C, 'status.replyFromOwner', 'Respondeu ao seu status'));
  const isImage = st.type === 'image'; const isVideo = st.type === 'video';
  const fb = isImage ? _tr(C, 'status.typePhoto', 'Foto') : isVideo ? _tr(C, 'status.typeVideo', 'Vídeo') : '';
  const accent = own ? 'rgba(255,255,255,0.85)' : C.otherInk;
  const created = st.created_at ? Date.parse(st.created_at) : (m.created_at ? Date.parse(m.created_at) : Date.now());
  const expired = !isNaN(created) && (Date.now() - created) > 24 * 60 * 60 * 1000;
  const mediaUrl = (expired && b64) ? b64 : ((st.thumb ? _mediaAbs(st.thumb) : '') || (st.media_url ? _mediaAbs(st.media_url) : '') || b64);
  const expTag = () => vstack([text(_tr(C, 'status.expiredShort', 'EXPIROU'), { fs: 8, fw: 700, c: '#FFFFFF', ls: 0.3, ml: 1 })], { pos: 'b', w: -1, bg: 'rgba(0,0,0,0.62)', p: [2, 0, 2, 0], al: 'c' });
  let thumb;
  if (mediaUrl) {
    thumb = zstack([
      image(mediaUrl, { w: 44, h: 56, r: 6, bg: '#222222', op: expired ? 0.55 : undefined, th: (b64 && b64 !== mediaUrl) ? b64 : undefined }),
      (isVideo && !expired) ? vstack([icon(IconPlay, { s: 14, c: '#FFFFFF' })], { pos: 'c', w: 44, h: 56, bg: 'rgba(0,0,0,0.25)', al: 'c', jc: 'c' }) : null,
      expired ? expTag() : null,
    ], { w: 44, h: 56, r: 6 });
  } else {
    thumb = zstack([
      vstack([text('Aa', { fs: 18, fw: 700, c: '#FFFFFF' })], { w: 44, h: 56, r: 6, bg: st.bg_color || '#111111', al: 'c', jc: 'c', op: expired ? 0.55 : undefined }),
      expired ? expTag() : null,
    ], { w: 44, h: 56, r: 6 });
  }
  const sub = own ? 'rgba(255,255,255,0.85)' : col.textSecondary;
  const info = [text(label, { fs: 11, fw: 700, c: accent, m: [0, 0, 2, 0], ls: 0.2 })];
  if (snippet) info.push(text(snippet, { fs: 12.5, c: sub, ml: 2 }));
  else if (fb) {
    info.push(hstack([
      isImage ? icon(IconImage, { s: 13, c: own ? 'rgba(255,255,255,0.8)' : col.textSecondary }) : isVideo ? icon(IconVideo, { s: 13, c: own ? 'rgba(255,255,255,0.8)' : col.textSecondary }) : null,
      text(fb, { fs: 12.5, c: sub }),
    ], { g: 5, al: 'c' }));
  }
  const reply = String((isReaction ? payload.reaction : payload.reply_text) || '');
  const w = _clampW(180, 300, 3 + 8 + 44 + 10 + 8 + Math.max(_estW(label, 11, true), Math.min(_estW(snippet, 12.5), 200)), _estW(reply, 16) + 4);
  const rt = isReaction ? text(reply, { fs: 34, lh: 42, c: own ? C.ownText : col.text }) : bodyText(reply); rt.mi = 1;
  row.bl = [
    hstack([
      vstack([], { w: 3, h: 72, bg: accent }),
      hstack([thumb, vstack(info, { fl: 1, jc: 'c' })], { fl: 1, p: 8, g: 10, al: 'c' }),
    ], { w: -1, r: 10, bg: own ? 'rgba(255,255,255,0.12)' : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'), m: [0, 0, 6, 0], a: 'st_open' }),
    rt,
  ];
  row.cw = w; row.pad = PAD; row.mp = 'in';
}

function buildViewOnce(m, row, ctx, C, own) {
  const col = C.colors || {};
  const V = _viewOnce(m, ctx);
  const title = V.isAudio ? _tr(C, 'chatConv.viewOnceVoiceLabel', 'Áudio único') : V.isVideo ? _tr(C, 'chatConv.viewOnceVideo', 'Vídeo único') : _tr(C, 'chatConv.viewOncePhoto', 'Foto única');
  let accent; let subtle; let circleBg; let Ic; let sub;
  if (own) {
    accent = col.text || '#111111'; subtle = col.textSecondary || 'rgba(0,0,0,0.5)';
    circleBg = /^#[0-9a-f]{6}$/i.test(accent) ? accent + '1f' : 'rgba(17,17,17,0.12)';
    Ic = V.isAudio ? IconMic : V.isVideo ? IconVideo : IconEye;
    sub = V.anyViewed ? _tr(C, 'chatConv.viewOnceOpened', 'Visualizada') : _tr(C, 'chatConv.viewOnceSent', 'Visualização única');
  } else {
    accent = col.primary || '#111111'; subtle = col.textSecondary || '#666666';
    circleBg = 'rgba(17, 17, 17,0.12)';
    Ic = V.isAudio ? IconMic : IconCheck;
    sub = V.isAudio ? _tr(C, 'chatConv.viewOnceVoiceExpired', 'Áudio expirado') : _tr(C, 'chatConv.viewOnceOpened', 'Aberta');
  }
  const w = _clampW(180, 260, 32 + 10 + Math.max(_estW(title, 14, true), _estW(sub, 12)) + 10 + 13 + 4);
  row.bl = [hstack([
    vstack([icon(Ic, { s: 16, c: accent })], { w: 32, h: 32, r: 16, bg: circleBg, al: 'c', jc: 'c' }),
    vstack([text(title, { fs: 14, fw: 600, c: accent, ml: 1 }), text(sub, { fs: 12, c: subtle, it: 1, ml: 1, m: [1, 0, 0, 0] })], { fl: 1 }),
    icon(IconLock, { s: 13, c: subtle }),
  ], { g: 10, al: 'c', p: [6, 4, 6, 0], w })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

function linkCard(url, C) {
  const pv = _lpFor(url, C);
  if (!pv) return null;
  const col = C.colors || {};
  let domain = pv.site_name || '';
  if (!domain) { try { domain = (url.match(/^https?:\/\/([^/]+)/i) || [])[1] || ''; } catch {} }
  domain = String(domain || '').replace(/^www\./i, '');
  const letter = (domain || pv.title || '?').trim().charAt(0).toUpperCase() || '?';
  const fbBg = C.lp && C.lp.color ? C.lp.color(domain || url) : '#444444';
  let fav = pv.favicon || null;
  if (!fav) { try { fav = (url.match(/^https?:\/\/[^/]+/i) || [])[0] + '/favicon.ico'; } catch {} }
  // [2026-10-15 yt-inline] YouTube → ícone de play sobre a miniatura (toque abre o player embutido).
  let isYt = false;
  try { isYt = !!require('./YouTubeInlinePlayer').youTubeInlineInfo(url); } catch {}
  const kids = [
    pv.image ? (isYt
      ? zstack([
        image(pv.image, { w: -1, h: 140, bg: '#00000010', fit: 'cover' }),
        vstack([icon(IconPlay, { s: 22, c: '#FFFFFF' })], { pos: 'c', w: 52, h: 52, r: 26, bg: 'rgba(0,0,0,0.62)', al: 'c', jc: 'c' }),
      ], { w: -1, h: 140 })
      : image(pv.image, { w: -1, h: 140, bg: '#00000010', fit: 'cover' }))
      : vstack([text(letter, { fs: 32, fw: 700, c: '#FFFFFF', ls: 1 })], { w: -1, h: 80, bg: fbBg, al: 'c', jc: 'c' }),
  ];
  const tc = [];
  if (domain) {
    tc.push(hstack([
      fav ? image(fav, { w: 14, h: 14, r: 3 }) : icon(IconGlobe, { s: 12, c: col.textTertiary }),
      text(domain.toUpperCase(), { fs: 10, ls: 0.5, fw: 600, c: col.textTertiary, fl: 1, ml: 1 }),
    ], { g: 6, m: [0, 0, 3, 0], al: 'c', w: -1 }));
  }
  if (pv.title) tc.push(text(String(pv.title), { fs: 13, fw: 600, m: [0, 0, 2, 0], lh: 18, ml: 2, c: col.text }));
  if (pv.description) tc.push(text(String(pv.description), { fs: 12, lh: 16, op: 0.85, ml: 2, c: col.textSecondary }));
  kids.push(vstack(tc, { p: [8, 12, 8, 12], w: -1 }));
  return vstack(kids, { id: 'lp', w: 280, r: 12, m: [6, 0, 0, 0], bg: col.surface, bc: col.border, bw: 0.5, a: 'lp:' + url });
}

// ─── buildCard ──────────────────────────────────────────────────────────────
export function buildCard(item, row, ctx) {
  const C = ctx && ctx.cards;
  if (!C || !item) return false;
  const k = cardKind(item, ctx);
  const own = _own(item, ctx);
  if (!k) {
    // Texto com link → cartão de prévia em row.post (mesma ordem do JS:
    // tradução vem ANTES; quem adicionar blocos ao post deve inserir antes
    // do nó id:'lp').
    if ((item.type || 'text') === 'text' && !item._type && !item.deleted_at && typeof item.content === 'string') {
      const mm = item.content.match(URL_RE);
      if (mm) {
        const card = linkCard(mm[0], C);
        if (card) row.post = (row.post || []).concat([card]);
      }
    }
    return false;
  }
  try {
    switch (k) {
      case 'location': buildLocation(item, row, ctx, C, own); break;
      case 'jloc': buildJsonLocation(_json(item.content) || {}, row, C); break;
      case 'contact': buildContact(item, row, ctx, C, own); break;
      case 'poll': buildPoll(item, row, ctx, C, own); break;
      case 'meetup': buildMeetup(item, row, ctx, C, own); break;
      case 'playlist': buildPlaylist(item, row, ctx, C); break;
      case 'jpl': buildJsonPlaylist(_json(item.content) || {}, row, C); break;
      case 'call_card': buildCallCard(item, row, ctx, C, own); break;
      case 'jcall': buildJsonCall(_json(item.content) || {}, row, ctx, C); break;
      case 'calltext': buildCallText(item, row, C, own); break;
      case 'giftext': buildGifText(item, row); break;
      case 'vn': buildVideoNote(item, row, ctx, C); break;
      case 'gift': buildGift(item, row, ctx, C, own); break;
      case 'status_reply': buildStatusReply(item, row, ctx, C, own); break;
      case 'vo': buildViewOnce(item, row, ctx, C, own); break;
      default: return false;
    }
  } catch (e) {
    if (__DEV__) console.warn('[native-cards]', k, e?.message);
    return false; // buildRow cai no caminho normal (que recusa o tipo → fallback JS)
  }
  if (!row.bl || !row.bl.length) return false;
  if (item._failed) row.fail = 1;
  return true;
}

// ─── ações (toques) ─────────────────────────────────────────────────────────
/**
 * deps: { conversationId, currentEmail, user, t, router, api, Linking, Share,
 *   Haptics, safeAlert, setMessages, mapKeep, cacheOne, pollVoteLocksRef,
 *   setMapModalData, setRoundVideoViewer, setPlaylistEditor, setScheduleToast,
 *   startCall, liveLocIntervalRef, liveLocTimeoutRef, liveLocMsgIdRef,
 *   setLiveLocActive, resolve, bump }
 */
export function runCardAction(item, action, D) {
  if (!item || !action || !D) return;
  const m = item;
  const s = String(action);
  const i = s.indexOf(':');
  const kind = i >= 0 ? s.slice(0, i) : s;
  const arg = i >= 0 ? s.slice(i + 1) : '';
  const t = D.t || ((k) => k);
  const tt = (k, fb) => { try { const v = t(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const api = D.api;
  try {
    switch (kind) {
      case 'lp': { // [2026-10-15 native-browser] prévia de link → helper único (app/navegador interno/sistema)
        if (!arg) return;
        try { if (require('./YouTubeInlinePlayer').openYouTubeInline(arg)) return; } catch {} // [2026-10-15 yt-inline]
        try { require('../../services/openLink').openLink(arg, { router: D.router }); } catch { D.Linking.openURL(arg).catch?.(() => {}); }
        return;
      }
      case 'loc': {
        const L = _loc(m);
        D.setMapModalData({ lat: L.lat, lng: L.lng, label: L.addr, isLive: L.isLive, liveUntil: L.until, isUnlimited: L.unlimited, messageId: m.id, conversationId: D.conversationId });
        return;
      }
      case 'jloc': {
        const j = _json(m.content) || {};
        D.setMapModalData({ lat: j.latitude, lng: j.longitude, label: String(j.label || j.address || 'Localização'), isLive: !!(j.live || m.live), liveUntil: j.live_until || m.live_until || null, messageId: m.id, conversationId: D.conversationId });
        return;
      }
      case 'loc_stop': {
        try { D.Haptics && D.Haptics.impactAsync(D.Haptics.ImpactFeedbackStyle.Medium); } catch {}
        try {
          if (D.liveLocIntervalRef.current) { clearInterval(D.liveLocIntervalRef.current); D.liveLocIntervalRef.current = null; }
          if (D.liveLocTimeoutRef.current) { clearTimeout(D.liveLocTimeoutRef.current); D.liveLocTimeoutRef.current = null; }
        } catch {}
        try { api.chatStopLiveLocation?.(m.id, { force: true })?.catch?.(() => {}); } catch {}
        if (D.liveLocMsgIdRef.current === m.id) D.liveLocMsgIdRef.current = null;
        D.setLiveLocActive(null);
        D.setMessages(prev => D.mapKeep(prev, x => {
          if (x.id !== m.id) return x;
          try {
            const c = JSON.parse(x.content || '{}');
            c.live_until = Math.floor(Date.now() / 1000) - 1; c.live = false; c.is_unlimited = false;
            return { ...x, content: JSON.stringify(c), is_unlimited: false };
          } catch { return x; }
        }));
        return;
      }
      case 'ct_msg': case 'ct_inv': case 'ct_save': case 'ct_call': {
        const ct = _contact(m, { t });
        if (kind === 'ct_call') { D.Linking.openURL(`tel:${ct.phone.replace(/[^+\d]/g, '')}`).catch?.(() => {}); return; }
        if (kind === 'ct_msg') {
          const chk = _ctMap.get(String(ct.email || '') + '|' + String(ct.phone || ''));
          const target = (chk && chk.email) || ct.email;
          if (target) D.router.push(`/chat-new?email=${encodeURIComponent(target)}`);
          else if (ct.phone) D.router.push(`/chat-new?phone=${encodeURIComponent(ct.phone)}`);
          return;
        }
        if (kind === 'ct_inv') {
          const inviteMsg = `${ct.name ? ct.name + ', ' : ''}${tt('chat.inviteShareMessage', 'instala o Chatyy: https://chatyy.com.br')}`;
          (async () => {
            if (ct.phone && Platform.OS !== 'web') {
              const clean = ct.phone.replace(/[^+\d]/g, '');
              const sep = Platform.OS === 'ios' ? '&' : '?';
              try { await D.Linking.openURL(`sms:${clean}${sep}body=${encodeURIComponent(inviteMsg)}`); }
              catch { try { await D.Share.share({ message: inviteMsg, title: 'Chatyy' }); } catch {} }
            } else { try { await D.Share.share({ message: inviteMsg, title: 'Chatyy' }); } catch {} }
          })();
          return;
        }
        // ct_save — mesmo fluxo do cartão JS (formulário do sistema → fallback addContactAsync)
        (async () => {
          try {
            const Contacts = require('expo-contacts');
            const form = {
              [Contacts.Fields.FirstName]: ct.name,
              ...(ct.phone ? { [Contacts.Fields.PhoneNumbers]: [{ label: 'mobile', number: ct.phone }] } : {}),
              ...(ct.email ? { [Contacts.Fields.Emails]: [{ label: 'home', email: ct.email }] } : {}),
            };
            if (typeof Contacts.presentFormAsync === 'function') {
              let ok = false;
              try {
                if (Platform.OS !== 'ios') {
                  const perm = await Contacts.requestPermissionsAsync();
                  if (perm?.status !== 'granted') { D.safeAlert(tt('chatConv.permission', 'Permissão'), tt('chatConv.contactsPermission', 'Permita acesso aos contatos.')); return; }
                }
                await Contacts.presentFormAsync(null, form, { isNew: true });
                ok = true;
              } catch {}
              if (ok) return;
            }
            const { status } = await Contacts.requestPermissionsAsync();
            if (status !== 'granted') { D.safeAlert(tt('chatConv.permission', 'Permissão'), tt('chatConv.contactsPermission', 'Permita acesso aos contatos.')); return; }
            await Contacts.addContactAsync(form);
            D.safeAlert(tt('common.success', 'Sucesso'), tt('chatConv.contactSaved', 'Contato salvo'));
          } catch {
            D.safeAlert(tt('common.error', 'Erro'), tt('chatConv.contactSaveError', 'Não foi possível salvar o contato'));
          }
        })();
        return;
      }
      case 'poll': { _vote(m, Number(arg), D); return; }
      case 'rsvp': {
        (async () => {
          const r = await api.chatMeetupRsvp(m.id, arg);
          if (r && r.success) {
            D.setMessages(prev => D.mapKeep(prev, x => {
              if (x.id !== m.id) return x;
              let content = x.content;
              try { const d = JSON.parse(x.content); if (r.data.rsvp) d.rsvp = r.data.rsvp; if (r.data.rsvps) d.rsvps = r.data.rsvps; content = JSON.stringify(d); } catch {}
              return { ...x, content, meetup: { ...(x.meetup || {}), ...(r.data || {}) } };
            }));
          }
        })().catch(() => {});
        return;
      }
      case 'pl_edit': {
        if (m._pending || typeof m.id === 'string') return;
        const pl = _json(m.content);
        if (pl) D.setPlaylistEditor({ messageId: m.id, playlist: pl });
        return;
      }
      case 'pl_song': {
        const pl = _json(m.content) || {};
        const song = (pl.songs || [])[Number(arg)];
        if (song && song.url && /^https?:\/\//i.test(song.url)) D.Linking.openURL(song.url).catch?.(() => {});
        return;
      }
      case 'call_back': { D.startCall(arg === 'v'); return; }
      case 'call_join': {
        const c = String(m.content || '');
        const isVideo = /^(Videochamada|Video Call)/i.test(c);
        const room = c.match(/meet\/([a-z0-9-]+)/i);
        if (room && room[1]) D.router.push(`/meet/${room[1]}${isVideo ? '' : '?video=off'}`);
        return;
      }
      case 'vn_open': {
        const uri = D.resolve ? D.resolve(m.file_url || m.content) : (m.file_url || m.content);
        if (uri) D.setRoundVideoViewer({ visible: true, uri, messageId: m.id });
        return;
      }
      case 'st_open': { _openStatus(m, D, tt); return; }
      default: return;
    }
  } catch (e) {
    if (__DEV__) console.warn('[native-cards] action', s, e?.message);
  }
}

function _openStatus(m, D, tt) {
  const payload = m.status_reply || _json(m.content);
  const st = payload && payload.status;
  if (!st) return;
  (async () => {
    const notAvail = () => { D.setScheduleToast(tt('status.notAvailable', 'Status não disponível')); setTimeout(() => D.setScheduleToast(''), 2400); };
    const created = st.created_at ? Date.parse(st.created_at) : (m.created_at ? Date.parse(m.created_at) : Date.now());
    if (!isNaN(created) && (Date.now() - created) > 24 * 60 * 60 * 1000) { notAvail(); return; }
    if (st.id) {
      try {
        const { statusCheck } = require('../../services/api');
        const r = await statusCheck(st.id);
        if (!(r?.success && r?.data?.exists)) { notAvail(); return; }
      } catch {}
    }
    if (!st.email) return;
    D.router.push(`/u/${encodeURIComponent(st.email)}?openStatus=1`);
  })().catch(() => {});
}

// Voto — espelho fiel do handleVote do render JS (toggle; única troca; merge
// com o servidor; persistência no cache + AsyncStorage).
function _vote(msg, optIdx, D) {
  const poll = _poll(msg);
  if (!poll || !Number.isInteger(optIdx) || optIdx < 0) return;
  const locks = D.pollVoteLocksRef;
  if (!locks.current) locks.current = new Set();
  const pollKey = poll.id || msg.id;
  if (locks.current.has(pollKey)) return;
  locks.current.add(pollKey);
  D.setMessages(prev => D.mapKeep(prev, m => {
    if (m.id !== msg.id) return m;
    const p = { ...(m.poll || poll || {}) };
    const my = new Set(p.my_votes || []);
    const counts = [...(p.vote_counts || [])];
    if (p.multiple_choice) {
      if (my.has(optIdx)) { my.delete(optIdx); counts[optIdx] = Math.max(0, (counts[optIdx] || 0) - 1); }
      else { my.add(optIdx); counts[optIdx] = (counts[optIdx] || 0) + 1; }
    } else if (my.has(optIdx)) { my.delete(optIdx); counts[optIdx] = Math.max(0, (counts[optIdx] || 0) - 1); }
    else {
      for (const pv of my) counts[pv] = Math.max(0, (counts[pv] || 0) - 1);
      my.clear(); my.add(optIdx); counts[optIdx] = (counts[optIdx] || 0) + 1;
    }
    const total = counts.reduce((a, b) => a + (b || 0), 0);
    return { ...m, poll: { ...p, my_votes: Array.from(my), vote_counts: counts, total_votes: total } };
  }));
  (async () => {
    try {
      const r = await D.api.chatVotePoll(poll.id || msg.id, optIdx);
      if (r?.success && r.data) {
        const sc = r.data.vote_counts || r.data.votes || [];
        const sm = r.data.my_votes || [];
        const stv = typeof r.data.total_votes === 'number' ? r.data.total_votes : sc.reduce((a, b) => a + (b || 0), 0);
        const empty = sc.length === 0 && sm.length === 0 && stv === 0;
        let updated = null;
        D.setMessages(prev => D.mapKeep(prev, m => {
          if (m.id !== msg.id) return m;
          if (empty) { updated = m; return m; }
          const next = { ...m, poll: { ...m.poll, vote_counts: sc, total_votes: stv, my_votes: sm } };
          updated = next; return next;
        }));
        if (updated) { try { D.cacheOne(D.conversationId, updated); } catch {} }
        try {
          const ue = (D.user && D.user.email) || '';
          if (ue && updated && updated.poll) {
            const AS = require('@react-native-async-storage/async-storage').default;
            AS.setItem(`poll_vote:${poll.id || msg.id}:${ue.toLowerCase()}`, JSON.stringify({
              my_votes: updated.poll.my_votes || [], vote_counts: updated.poll.vote_counts || [], total_votes: updated.poll.total_votes || 0, at: Date.now(),
            })).catch(() => {});
          }
        } catch {}
      }
    } catch (e) {
      try { console.warn('[poll vote]', e?.message); } catch {}
    } finally {
      locks.current.delete(pollKey);
    }
  })();
}
