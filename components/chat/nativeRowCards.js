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
//   loc · loc_stop · jloc · ct_msg · ct_inv · ct_save · ct_call · ct_open · poll:<i> ·
//   rsvp:<going|maybe|not_going> · mt_map · mt_edit · mt_info · pl_edit · pl_song:<i> · call_back:<v|a> ·
//   call_join · st_open · vn_open · gift_thank · lp:<url> · lr:<share|decline|cancel>
import { Platform } from 'react-native';
import {
  vstack, hstack, zstack, text, image, avatar, loader, videoNote, icon, toArgb, spacer, iconPaths,
} from './nativeNodes';
import { inkAlpha, onInk, pollStats, pollTexts, showPollVotes } from './pollLook'; // [2026-10-16 poll-wa]
import { viewOncePaths, viewOnceRingPaths, viewOnceState } from './viewOnceGlyphs'; // [2026-10-21 view-once WA]
import {
  IconMapPin, IconUser, IconUserPlus, IconPlus, IconPhone, IconVideo, IconCalendar, IconClock,
  IconCheckCircle, IconHelpCircle, IconPlay, IconPencil, IconMusic, IconEye, IconLock,
  IconCheck, IconMic, IconImage, IconVideoNote, IconGlobe, IconDiamond, IconX,
  IconFile, IconFilm, IconMessageCircle, IconChevronRight, IconSmile, IconUsers,
} from '../Icons';
import { parseContactPayload, contactTitle, contactBusy, phonebookStateSync, checkPhonebook, subscribeContactState } from './contactShare'; // [2026-10-17 share-contact]
import { previewForMessage, isFreshMessage, LP_SKELETON } from './linkPreviewState'; // [linkpreview 2026-10-18]
import { IconTrophy as _IconGameTrophy, gameTypeIconComp as _gameIconComp } from '../games/GameIcons'; // [jogos 2026-10-18]

// ─── utilidades ─────────────────────────────────────────────────────────────
// [2026-10-19 tg-style] cartão de link com os cantos/tipografia da citação nativa
// (cantos 6, domínio 12/600). Kill switch: globalThis.__chatyy_tg_bubbles = false.
function _tgB() { try { return globalThis.__chatyy_tg_bubbles !== false; } catch { return true; } }
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
function _lpFor(url, C, delayMs = 300) {
  const lp = C.lp;
  if (!lp || typeof lp.get !== 'function') return null;
  if (lp.skip && lp.skip(url)) return null;
  const v = lp.get(url);
  if (v !== undefined) return v || null;
  if (_lpInflight.has(url)) return null;
  _lpInflight.add(url);
  // Mesmo debounce de 300 ms do LinkPreview JS. [linkpreview 2026-10-18] msg recém-chegada: espera o
  // patch WS do servidor (message_update) antes de buscar — re-checa o cache na hora de ir à rede.
  setTimeout(() => {
    try { const v2 = lp.get(url); if (v2 !== undefined) { _lpInflight.delete(url); try { C.bump && C.bump(); } catch {} return; } } catch {}
    let api = null;
    try { api = require('../../services/api'); api = api.default || api; } catch { api = null; }
    const done = (val) => { _lpInflight.delete(url); try { lp.set(url, val); } catch {} try { C.bump && C.bump(); } catch {} };
    if (!api || typeof api.chatLinkPreview !== 'function') { _lpInflight.delete(url); return; }
    Promise.resolve(api.chatLinkPreview(url)).then((r) => {
      if (r && r.success && r.data && (r.data.title || r.data.image)) done(r.data);
      else done(false);
    }).catch(() => done(false));
  }, delayMs);
  return null;
}

function _pstnEnabled() { try { return require('../../constants/featureFlags').isPstnEnabled() === true; } catch { return false; } }
const _ctMap = new Map(); // email|phone → { loading, has, email }
function _ctFor(email, phone, C, chatyy) {
  const key = String(email || '') + '|' + String(phone || '');
  if (!email && !phone) return { loading: false, has: false };
  const hit = _ctMap.get(key);
  // [2026-10-20 perf-js] LRU (toque no get): FIFO 400 despejava cartões ainda
  // carregados → nova checagem → bump → rebuild de todas as linhas (laço).
  if (hit) { if (!hit.loading) { _ctMap.delete(key); _ctMap.set(key, hit); } return hit; }
  // [2026-10-17 share-contact] cartão novo já diz que a pessoa tem Chatyy (e-mail) → "Mensagem" na hora, sem rede.
  // [privacidade] não confia no chatyy:true do remetente (quem desligou 'ser encontrado'); sempre checa no servidor.
  const ent = { loading: true, has: false, email };
  _ctMap.set(key, ent);
  if (_ctMap.size > 1200) { const k0 = _ctMap.keys().next().value; if (k0 !== key) _ctMap.delete(k0); }
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
      // [2026-10-19 info-cache] SWR: versão nova ainda não no disco → última foto boa (download em 2º plano).
      try { const ac = require('../../services/avatarCache'); disk = ac.getAvatarUriSWR ? ac.getAvatarUriSWR(remote) : ac.getCachedAvatarUriOrNull(remote); } catch {}
      u = disk || remote || '';
    }
  } catch { u = ''; }
  return avatar({ s: size, u: u || undefined, tx: _initials(name, email), bg: c1, bg2: toArgb(c2), c: '#ffffff', fs: Math.round(size * 0.38) });
}

// ─── arte do presente (LiveGiftGlyph.giftArt → paths) ──────────────────────
// [gift-native 2026-10-16] Raiz do "círculo vazio": antes chamava o COMPONENTE
// LiveGiftGlyph fora do render; com o React Compiler ele usa useMemoCache e
// LANÇA fora do render → try/catch engolia → ps vazio → glifo null. Agora usa a
// função pura giftArt(). Degradês: ...s (prata) → cinza claro chapado, ...g
// (brilho radial) → branco com alpha baixo, ...d (diamante) → azul.
// Elipse com transform rotate() vira polígono já girado (o nó 'ic' não tem transform).
const _giftMemo = new Map();
export function giftGlyphPaths(iconName) {
  const k = String(iconName || 'gift');
  let ent = _giftMemo.get(k);
  if (ent) return ent;
  const ps = [];
  let vb = 48;
  try {
    const mod = require('../live/LiveGiftGlyph');
    const art = mod && mod.giftArt;
    const el = typeof art === 'function' ? art(iconName, 48) : null;
    const paint = (v) => {
      if (v === undefined || v === null) return undefined;
      if (v === 'none' || v === 'transparent') return 0;
      const s = String(v);
      if (s.startsWith('url(')) {
        if (/g\)$/.test(s)) return { glow: 1 };
        if (/d\)$/.test(s)) return toArgb('#7CC8FF');
        return toArgb('#dcdcdc');
      }
      return toArgb(s);
    };
    const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
    const shapeD = (name, p) => {
      if (name === 'Circle' || name === 'Ellipse') {
        const cx = n(p.cx); const cy = n(p.cy); const rx = name === 'Circle' ? n(p.r) : n(p.rx); const ry = name === 'Circle' ? n(p.r) : n(p.ry);
        if (!(rx > 0 && ry > 0)) return '';
        const rot = /rotate\(\s*(-?[\d.]+)/.exec(String(p.transform || ''));
        if (rot) {
          const a = (n(rot[1]) * Math.PI) / 180; const ca = Math.cos(a); const sa = Math.sin(a);
          let d = '';
          for (let i = 0; i <= 48; i++) {
            const tt = (i / 48) * Math.PI * 2; const x = rx * Math.cos(tt); const y = ry * Math.sin(tt);
            d += `${i ? 'L' : 'M'}${(cx + x * ca - y * sa).toFixed(2)} ${(cy + x * sa + y * ca).toFixed(2)}`;
          }
          return d + 'Z';
        }
        return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
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
        if (fill && typeof fill === 'object') { e.f = toArgb('#ffffff'); e.o = 0.13; } else if (fill) e.f = fill;
        if (stroke && typeof stroke !== 'object' && sw > 0) { e.k = stroke; e.w = sw; }
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
  if (ps.length) _giftMemo.set(k, ent); // falha não fica memorizada
  return ent;
}
function _giftGlyph(iconName, size) {
  const ent = giftGlyphPaths(iconName);
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
  // [2026-10-21 polish-conv] NaN/'' → null (antes abria o mapa em 0,0).
  const _num = (v) => { if (v == null || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const lat = _num(loc.latitude ?? loc.lat ?? m.latitude);
  const lng = _num(loc.longitude ?? loc.lng ?? m.longitude);
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
  // [2026-10-17 share-contact] formato v2 (phones[], chatyy, contacts[] p/ vários) — retrocompatível.
  let P = null;
  try { P = parseContactPayload(ct); } catch { P = null; }
  const f = (P && P.first) || {};
  const name = String(f.name || ct.name || ct.phone || ct.email || _tr(C, 'chatConv.contact', 'Contato'));
  return {
    name, phone: f.phone || (ct.phone ? String(ct.phone) : ''), email: f.email || (ct.email ? String(ct.email) : ''),
    phones: (f.phones && f.phones.length) ? f.phones : (ct.phone ? [String(ct.phone)] : []),
    chatyy: !!f.chatyy, count: (P && P.count) || 1, parsed: P,
  };
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
    case 'voicemail': case 'lottie_sticker': // [2026-10-16 native-cover]
    case 'game': // [jogos 2026-10-18]
      return type;
    case 'location_request': return _lrOn() ? type : null; // [loc-pedido 2026-10-19] desligado = cartao-resumo
    case 'watch_session': return _watchOn() ? type : null; // [assistir-junto 2026-10-20] desligado = fallback (texto legível)
    // [2026-10-16 native-cover] vídeo redondo antigo (200 px) → mesma nota de vídeo nativa
    case 'video_message': return (item.file_url || item._localUri) ? 'vn' : null;
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
  if (_clOn() && _parseCallLink(c)) return 'clink'; // [call-link 2026-10-19] link de chamada → cartão com Entrar
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
    // [2026-10-16 native-cover] receptor sem ver: cartão nativo "Toque para ver"
    // (ação vo_open → o MESMO viewer do JS, ViewOnceMessage autoOpen).
    case 'vo': return '';
    case 'vn': return (item.file_url || item.content || item._localUri) ? '' : 'vn-nourl';
    case 'poll': return _poll(item) ? '' : 'poll-raw';
    case 'meetup': case 'playlist': case 'call_card': return _json(item.content) ? '' : k + '-raw';
    case 'game': { try { return require('../../services/games').parseGameContent(item.content) ? '' : 'game-raw'; } catch { return 'game-raw'; } } // [jogos 2026-10-18]
    case 'location': return '';
    case 'watch_session': { try { return require('../../services/watchTogether').parseWatchContent(item.content) ? '' : 'watch-raw'; } catch { return 'watch-raw'; } } // [assistir-junto 2026-10-20]
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
      // [2026-10-16 mapa-chat] pino = foto de quem compartilha com anel P&B +
      // halo (a lista nativa não anima); selo "AO VIVO · 59 min" no canto —
      // sem a faixa inferior duplicada ("Compartilhando até…").
      const pc = isDark ? '#FFFFFF' : '#111111';
      kids.push(vstack([], { pos: 'c', w: 60, h: 60, r: 30, bg: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(17,17,17,0.14)' }));
      let pinNode = null;
      try { pinNode = _avatarNode(m.sender_name || '', m.sender_email || '', 32); } catch { pinNode = null; }
      kids.push(pinNode
        ? vstack([pinNode], { pos: 'c', w: 38, h: 38, r: 19, bg: pc, al: 'c', jc: 'c' })
        : vstack([], { pos: 'c', w: 16, h: 16, r: 8, bg: pc, bc: '#FFFFFF', bw: 2.5 }));
      let chipRest = '';
      if (L.unlimited) chipRest = '∞';
      else if (L.until) {
        const rem = Number(L.until) - Math.floor((Number(C.now) || Date.now()) / 1000);
        if (rem > 0) { const mm = Math.max(1, Math.floor(rem / 60)); chipRest = mm >= 60 ? `${Math.floor(mm / 60)} h${mm % 60 ? ` ${mm % 60} min` : ''}` : `${mm} min`; }
      }
      kids.push(hstack([
        vstack([], { w: 6, h: 6, r: 3, bg: '#FFFFFF' }),
        text(_tr(C, 'chatConv.liveBadge', 'AO VIVO'), { fs: 10, fw: 800, c: '#FFFFFF', ls: 0.3 }),
        chipRest ? text(chipRest, { fs: 10, fw: 600, c: 'rgba(255,255,255,0.8)' }) : null,
      ].filter(Boolean), { pos: 'tl', m: [8, 0, 0, 8], bg: 'rgba(0,0,0,0.78)', r: 12, p: [3, 8, 3, 8], g: 5, al: 'c' }));
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
    // [2026-10-16 mapa-chat] endereço (quando houver) em vez de "Compartilhando • 59 min rest…" cortado
    const _addrOk = L.addr && !/^\s*-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+\s*$/.test(L.addr);
    if (_addrOk) sub = L.addr;
    else {
      const rest = L.unlimited ? ('∞ ' + _tr(C, 'snapmap.alwaysOn', 'sempre ativo')) : (C.formatLiveTimeRemaining ? C.formatLiveTimeRemaining(L.until, C.t) : '');
      sub = `${_tr(C, 'chatConv.sharingLive', 'Compartilhando')} • ${rest}`;
    }
  } else sub = _tr(C, 'chatConv.tapToOpenMap', 'Toque para abrir no mapa');
  const footer = hstack([
    vstack([
      text(title, { fs: 14, fw: 600, c: P.text, ml: 1 }),
      text(sub, { fs: 12, c: P.meta, ml: 1, m: [2, 0, 0, 0] }),
    ], { fl: 1 }),
    (L.active && own) ? vstack([text(_tr(C, 'chatConv.stopSharing', 'Parar'), { fs: 12, fw: 700, c: '#111111' })], { p: [6, 12, 6, 12], r: 14, bg: '#FFFFFF', m: [0, 0, 0, 4], a: 'loc_stop' }) : null,
  ], { p: [7, 6, 0, 6], g: 8, al: 'c' });
  row.bl = [vstack([map, footer], { w: CARD_W, ...(hasCoords ? { a: 'loc' } : {}) })];
  row.cw = CARD_W;
  row.pad = [4, 4, 5, 4];
  row.mp = 'below';
}

function buildJsonLocation(j, row, C) {
  const col = C.colors || {};
  const label = String(j.label || j.address || _tr(C, 'chatConv.location', 'Localização'));
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

// [2026-10-21 contato-msg] cartão → objeto de contato da contactShare (mesma chave e-mail|telefone do cartão JS).
function _ctObj(ct) { return (ct.parsed && ct.parsed.first) || { name: ct.name, email: ct.email, phone: ct.phone, phones: ct.phones }; }
let _ctBump = null; let _ctUnsub = null;
function _ctWatch(C) {
  if (C && typeof C.bump === 'function') _ctBump = C.bump;
  if (_ctUnsub) return;
  try { _ctUnsub = subscribeContactState(() => { try { _ctBump && _ctBump(); } catch {} }); } catch {}
}

function buildContact(m, row, ctx, C, own) {
  const ct = _contact(m, C);
  if (ct.count > 1 && ct.parsed) { buildContactMulti(ct, row, C, own); return; }
  const P = _palette(own, C);
  const col = P.col; const isDark = P.dark;
  const flag = ''; // [2026-10-21 polish-conv] sem bandeira emoji (regra: nada de emoji na UI; o DDI já está no número). _flag mantido p/ referência.
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
  const chk = _ctFor(ct.email, ct.phone, C, ct.chatyy);
  // [2026-10-21 contato-msg] estado compartilhado c/ o cartão JS: abrindo conversa (loader) e "já salvo na agenda".
  _ctWatch(C);
  const cto = _ctObj(ct);
  const busy = contactBusy(cto);
  let book = phonebookStateSync(cto);
  if (!book && Platform.OS !== 'web') { try { checkPhonebook(cto); } catch {} book = null; }
  const saved = !!(book && book.saved);
  const btn = (kids, a) => hstack(kids, { fl: 1, jc: 'c', al: 'c', g: 6, p: [11, 0, 11, 0], a });
  const vdiv = () => vstack([], { w: 0.5, h: 40, bg: dividerColor });
  const first = (chk.loading || busy === 'msg')
    ? btn([loader({ s: 20, c: accent })], undefined)
    : (chk.has
      ? btn([icon(IconUser, { s: 14, c: accent }), text(_tr(C, 'chatConv.sendMessage', 'Mensagem'), { fs: 13, fw: 600, c: accent })], 'ct_msg')
      : btn([icon(IconUserPlus, { s: 14, c: accent }), text(_tr(C, 'chat.invite', 'Convidar'), { fs: 13, fw: 600, c: accent })], 'ct_inv'));
  const actions = [first, vdiv(), saved
    ? btn([icon(IconCheck, { s: 14, c: accent }), text(_tr(C, 'shareContact.saved', 'Salvo'), { fs: 13, fw: 600, c: accent })], 'ct_save')
    : btn([icon(IconPlus, { s: 14, c: accent }), text(_tr(C, 'chatConv.addContact', 'Adicionar'), { fs: 13, fw: 600, c: accent })], 'ct_save')];
  // [2026-10-17 sem-pstn] "Ligar" = ligação Chatyy p/ quem tem conta; [2026-10-21 contato-msg] sem Chatyy
  // + número → telefone do aparelho (com confirmação). tel: direto só c/ kill switch.
  const _pstnOn = _pstnEnabled();
  const _isMe = !!(ctx && ctx.myEmail) && String(chk.email || ct.email || '').toLowerCase() === String(ctx.myEmail).toLowerCase();
  if (!_isMe && (_pstnOn ? !!ct.phone : (!chk.loading && (chk.has ? !!(chk.email || ct.email) : !!ct.phone)))) actions.push(vdiv(), btn([icon(IconPhone, { s: 14, c: accent }), text(_tr(C, 'chatConv.callContact', 'Ligar'), { fs: 13, fw: 600, c: accent })], 'ct_call'));
  const w = _clampW(250, 300, 12 + 56 + 12 + 12 + Math.max(Math.min(_estW(ct.name, 16, true), 180), _estW(pretty, 13.5) + (flag ? 24 : 0), _estW(ct.email, 12.5)));
  row.bl = [vstack([
    hstack([_avatarNode(ct.name, ct.email, 56), vstack(info, { fl: 1 })], { g: 12, p: [12, 12, 10, 12], al: 'c', a: 'ct_open' }),
    vstack([], { w: -1, h: 0.5, bg: dividerColor }),
    hstack(actions, { w: -1, al: 'c' }),
  ], { w, r: 14, bg: cardBg })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

// [2026-10-17 share-contact] Vários contatos numa mensagem (WhatsApp): avatares
// sobrepostos + "Sara e mais 2" + "N contatos"; botão "Ver todos" → folha.
function buildContactMulti(ct, row, C, own) {
  const P = _palette(own, C);
  const isDark = P.dark;
  const col = P.col;
  const cardBg = own ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.18)') : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)');
  const dividerColor = own ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17, 17, 17,0.18)') : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)');
  const accent = own ? C.ownText : C.otherInk;
  const list = ct.parsed.list.slice(0, 3);
  const AV = 40; const STEP = 24;
  const stackW = AV + (list.length - 1) * STEP;
  const avatars = zstack([
    vstack([], { w: stackW, h: AV }),
    ...list.map((c, i) => hstack([i ? spacer({ w: i * STEP }) : null, _avatarNode(c.name, c.email, AV)], { pos: 'tl' })),
  ], {});
  const title = contactTitle(ct.parsed, C.t);
  const subT = _tr(C, 'shareContact.nContacts', '{n} contatos').split('{n}').join(String(ct.parsed.count));
  const w = _clampW(250, 300, 12 + stackW + 12 + 12 + Math.min(_estW(title, 16, true), 190));
  row.bl = [vstack([
    hstack([avatars, vstack([
      text(title, { fs: 16, fw: 700, c: own ? C.ownText : col.text, lh: 20, ml: 2 }),
      text(subT, { fs: 13, c: own ? C.ownMeta : col.textSecondary, m: [3, 0, 0, 0] }),
    ], { fl: 1 })], { g: 12, p: [12, 12, 10, 12], al: 'c', a: 'ct_open' }),
    vstack([], { w: -1, h: 0.5, bg: dividerColor }),
    hstack([hstack([icon(IconUsers, { s: 15, c: accent }), text(_tr(C, 'shareContact.viewAll', 'Ver todos'), { fs: 13, fw: 600, c: accent })], { fl: 1, jc: 'c', al: 'c', g: 6, p: [11, 0, 11, 0], a: 'ct_open' })], { w: -1, al: 'c' }),
  ], { w, r: 14, bg: cardBg })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

// [2026-10-16 poll-wa] Enquete estilo WhatsApp: ocupa a bolha toda (sem cartão
// branco aninhado — a altura do cartão antigo saía errada e cortava o rodapé),
// título em negrito, "Selecione…", opção = check redondo + texto + contagem e
// barra FINA embaixo; hairline + "Ver votos"; hora/✓✓ abaixo (mp 'below').
// Sem z-stack/pb "preencher" (o iOS media pb w:-1 como 24 dp) → larguras explícitas.
function buildPoll(m, row, ctx, C, own) {
  const poll = _poll(m);
  const P = _palette(own, C);
  const ink = own ? C.ownText : (P.col.text || C.otherInk || '#111111');
  const meta = P.meta || inkAlpha(ink, 0.6);
  const fs = Number(C.fontSize) || 16;
  const S = pollStats(poll);
  const T = pollTexts(poll, (k) => _tr(C, k, k));
  let longest = Math.min(_estW(poll.question, fs + 1, true), 300);
  for (const r of S.rows) longest = Math.max(longest, 32 + Math.min(_estW(r.text, 15), 240) + 28);
  const w = _clampW(250, 300, longest);
  const BAR_X = 32; // círculo 22 + vão 10 → barra alinhada ao texto
  const barW = Math.max(40, w - BAR_X);
  const track = inkAlpha(ink, own ? 0.28 : 0.14);
  const fill = ink;
  const green = '#10B981'; const red = '#EF4444';
  const kids = [
    text(String(poll.question || ''), { fs: fs + 1, fw: 700, c: ink, lh: fs + 6 }),
    text(S.isQuiz ? `${T.quiz} · ${T.sub}` : T.sub, { fs: 12.5, c: meta, m: [3, 0, 6, 0] }),
  ];
  S.rows.forEach((r, idx) => {
    const showQuiz = S.isQuiz && S.hasVoted && S.correct >= 0;
    const isCorrect = showQuiz && idx === S.correct;
    const isWrong = showQuiz && r.mine && idx !== S.correct;
    const filled = r.mine || isCorrect;
    const dot = isCorrect ? green : (isWrong ? red : ink);
    const circle = vstack([
      filled || isWrong ? icon(isWrong ? IconX : IconCheck, { s: 13, c: (isCorrect || isWrong) ? '#FFFFFF' : onInk(ink) }) : null,
    ], {
      w: 22, h: 22, r: 11, al: 'c', jc: 'c',
      bg: (filled || isWrong) ? dot : undefined,
      bc: (filled || isWrong) ? undefined : inkAlpha(ink, own ? 0.6 : 0.4),
      bw: (filled || isWrong) ? 0 : 1.5,
    });
    kids.push(vstack([
      hstack([
        circle,
        text(r.text, { fs: 15, lh: 20, c: ink, fw: r.mine ? 600 : 400, fl: 1, ml: 3 }),
        S.total > 0 ? text(String(r.count), { fs: 14, fw: 600, c: r.mine ? ink : meta, ta: 'r' }) : null,
      ], { w: -1, g: 10, al: 'c' }),
      hstack([
        spacer({ w: BAR_X, h: 5 }),
        { t: 'pb', id: `p${m.id}_${idx}`, v: r.frac, h: 5, w: barW, r: 2.5, c: toArgb(isCorrect ? green : (isWrong ? red : fill)), bg: toArgb(track) },
      ], { m: [7, 0, 0, 0] }),
    ], { w: -1, p: [8, 0, 7, 0], a: `poll:${idx}` }));
  });
  if (S.isQuiz && S.hasVoted && poll.explanation) {
    kids.push(vstack([
      text(T.explanation, { fs: 11.5, fw: 700, c: meta, m: [0, 0, 2, 0] }),
      text(String(poll.explanation), { fs: 13, c: ink, lh: 17 }),
    ], { m: [6, 0, 2, 0], p: [8, 10, 8, 10], r: 10, w: -1, bg: inkAlpha(ink, 0.08) }));
  }
  kids.push(vstack([], { w: -1, h: 0.5, bg: inkAlpha(ink, own ? 0.3 : 0.16), m: [6, 0, 0, 0] }));
  kids.push(vstack([
    text(T.viewVotes, { fs: 15, fw: 600, c: S.total > 0 ? ink : meta, ta: 'c' }),
  ], { w: -1, al: 'c', p: [10, 0, 2, 0], a: S.total > 0 ? 'poll_votes' : undefined }));
  row.bl = [vstack(kids, { w })];
  row.cw = w; row.pad = [9, 12, 7, 12]; row.mp = 'below';
}

function _meetupLoc(raw) {
  try { return require('../meetup/meetupLocation').parseMeetupLocation(raw); } catch { return { text: String(raw || ''), lat: null, lng: null }; }
}

// [2026-10-20 encontro-glyph] founder: "quadrado vazio" no cartão — icon(IconCalendar/
// IconClock/IconMapPin/IconCheckCircle) em traço saía vazio no nativo. Glifos CHEIOS só com
// M/H/V/C/Z (sem arco); calendário = retângulos (sem furo/evenodd).
const MT_GLYPH_CAL = [
  'M3 6C3 4.9 3.9 4 5 4H19C20.1 4 21 4.9 21 6V9H3Z',
  'M7 2H9V6H7Z', 'M15 2H17V6H15Z',
  'M3 9H5V20H3Z', 'M19 9H21V20H19Z',
  'M3 19H21V20C21 21.1 20.1 22 19 22H5C3.9 22 3 21.1 3 20Z',
  'M7 12H11V16H7Z',
];
const MT_GLYPH_PIN = 'M12 2C8.13 2 5 5.13 5 9C5 14.25 12 22 12 22C12 22 19 14.25 19 9C19 5.13 15.87 2 12 2Z';

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
  let MS = { cancelled: false, updated: false };
  try { MS = require('../meetup/meetupLocation').meetupState(mt); } catch {}
  const past = MS.cancelled || (!isNaN(d.getTime()) && d.getTime() < Date.now());
  const canEdit = own && !MS.cancelled && typeof m.id === 'number' && !m.deleted_at; // [encontro2 2026-10-20]
  const ic = past ? '#6b7280' : '#111111';
  const w = _clampW(240, 280, 24 + 36 + 8 + Math.min(_estW(mt.title, 14, true), 200), 20 + 20 + _estW(dateStr, 12.5, true));
  const body = [
    text(String(dateStr || ''), { fs: 13, fw: 700, c: own ? C.ownText : col.text, m: [0, 0, 6, 0] }),
  ];
  if (mt.location) {
    // [encontro 2026-10-19] "Lugar, Endereço|lat,lng" → mapa estático c/ pino + endereço; toque (mt_map)
    // abre o visualizador nativo (Como chegar: Apple Maps / Google Maps / Waze). Sem coords → busca no Maps.
    const ML = _meetupLoc(mt.location);
    const hasC = ML.lat != null && ML.lng != null;
    let mapNode = null;
    if (hasC) {
      let u = '';
      try { const sm = require('../BoraMap').chatyyStaticMap(ML.lat, ML.lng, { zoom: 15, dark: isDark, pin: true }); u = sm ? sm.api : ''; } catch {}
      if (u) mapNode = vstack([image(u, { w: -1, h: 112, fit: 'cover', bg: isDark ? '#2C2C2E' : '#E5E5EA' })], { w: -1, h: 112, r: 10, bg: isDark ? '#2C2C2E' : '#E5E5EA', m: [0, 0, 6, 0] });
    }
    body.push(vstack([
      mapNode,
      hstack([iconPaths([{ d: MT_GLYPH_PIN, f: past ? ic : (own ? C.ownText : col.text) }], { s: 14 }), text(String(ML.text || ''), { fs: 12, c: own ? C.ownMeta : col.textSecondary, fl: 1, ml: 2 })], { g: 6, al: 'c', w: -1 }),
    ].filter(Boolean), { w: -1, m: [0, 0, 4, 0], a: 'mt_map' }));
  }
  if (mt.description) body.push(text(String(mt.description), { fs: 12, c: own ? C.ownMeta : col.textSecondary, m: [2, 0, 4, 0], ml: 3 }));
  body.push(hstack([
    total === 0
      ? text(_tr(C, 'chatConv.meetupNoRsvp', 'Ninguém confirmou ainda'), { fs: 11, fw: 600, c: own ? C.ownMeta : col.textSecondary })
      : text(`${going} ${_tr(C, 'chatConv.going', 'vão')}`, { fs: 11, fw: 700, c: own ? C.ownText : col.text }),
    maybe > 0 ? text(`${maybe} ${_tr(C, 'chatConv.maybe', 'talvez')}`, { fs: 11, fw: 600, c: own ? C.ownMeta : col.textSecondary }) : null,
    total > 0 ? { t: 'sp', fl: 1 } : null,
    total > 0 ? text(`${total} ${total === 1 ? _tr(C, 'chatConv.attendee', 'participante') : _tr(C, 'chatConv.attendees', 'participantes')}`, { fs: 10, c: own ? C.ownMeta : C.otherMeta }) : null,
  ], { m: [4, 0, 8, 0], g: 12, al: 'c', w: -1, a: 'mt_info' }));
  const labels = { going: _tr(C, 'chatConv.imGoing', 'Vou!'), maybe: _tr(C, 'chatConv.imMaybe', 'Talvez'), not_going: _tr(C, 'chatConv.imNotGoing', 'Não vou') };
  const act = { going: '#22c55e', maybe: '#f59e0b', not_going: '#ef4444' };
  body.push(hstack(['going', 'maybe', 'not_going'].map((s) => {
    const on = my === s;
    const tc = MS.cancelled ? (own ? C.ownMeta : col.textTertiary || '#8E8E93') : (on ? '#FFFFFF' : (own ? C.ownText : col.text));
    return vstack([text(labels[s], { fs: 12, c: tc, fw: on ? 700 : 500 })], {
      fl: 1, p: [7, 0, 7, 0], r: 8, al: 'c', bg: on && !MS.cancelled ? act[s] : undefined,
      bw: on && !MS.cancelled ? 0 : 1, bc: own ? inkAlpha(C.ownText || '#FFFFFF', 0.18) : inkAlpha(col.text || '#111111', 0.16), // [2026-10-21 contraste] destaque claro // [2026-10-21 polish-conv] border rgba+'60' virava PRETO no toArgb
      ...(MS.cancelled ? {} : { a: `rsvp:${s}` }),
    });
  }), { g: 6, w: -1 }));
  row.bl = [vstack([
    hstack([
      vstack([iconPaths(MT_GLYPH_CAL.map((d) => ({ d, f: '#FFFFFF' })), { s: 18 })], { w: 36, h: 36, r: 10, bg: 'rgba(255,255,255,0.2)', al: 'c', jc: 'c' }),
      vstack([
        text(String(mt.title || ''), { fw: 700, fs: 14, c: '#FFFFFF', ml: 2 }),
        past ? text(MS.cancelled ? _tr(C, 'chatConv.meetupCancelled', 'Encontro cancelado') : _tr(C, 'chatConv.eventPast', 'Evento encerrado'), { fs: 10, c: 'rgba(255,255,255,0.75)', fw: 600 }) : null,
        !past && MS.updated ? text(_tr(C, 'chatConv.meetupUpdatedBadge', 'ATUALIZADO'), { fs: 10, c: 'rgba(255,255,255,0.85)', fw: 700, ls: 0.3 }) : null,
      ], { fl: 1 }),
      canEdit ? vstack([text(_tr(C, 'chatConv.edit', 'Editar'), { fs: 11, fw: 700, c: '#FFFFFF' })], { p: [4, 9, 4, 9], r: 8, bg: 'rgba(255,255,255,0.18)', a: 'mt_edit' }) : null,
    ], { w: -1, bg: past ? '#6b7280' : '#111111', p: [8, 12, 8, 12], g: 8, al: 'c', a: 'mt_info' }),
    vstack(body, { w: -1, p: 10, bg: own ? inkAlpha(C.ownText || '#FFFFFF', 0.08) : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)') }),
  ], { w, r: 12, m: [1, 0, 1, 0] })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

// [2026-10-19 playlist-glyph] Glifos CHEIOS (viewBox 24, sem arcos/traço) — icon(IconMusic/
// IconPencil/IconPlay) em traço fino saía como quadrado vazio no balão nativo (igual
// ao cartão de chamada de 18/10).
const PL_GLYPH_NOTE = 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z';
const PL_GLYPH_PLAY = 'M8 5v14l11-7z';
const PL_GLYPH_PENCIL = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';

function buildPlaylist(m, row, ctx, C) {
  const pl = _json(m.content) || {};
  const isDark = !!C.isDark;
  const songs = Array.isArray(pl.songs) ? pl.songs : [];
  const txt = isDark ? '#f5f5f5' : '#111827';
  const sub = isDark ? 'rgba(255,255,255,0.55)' : '#64748b';
  const ink = isDark ? 'rgba(255,255,255,0.7)' : '#111111';
  const byName = String(pl.created_by_name || '').trim();
  const subLine = `${songs.length} ${songs.length === 1 ? _tr(C, 'chatConv.song', 'música') : _tr(C, 'chatConv.songs', 'músicas')}${byName ? ` · ${_tr(C, 'chatConv.by', 'por')} ${byName}` : ''}`;
  let need = 20 + 38 + Math.max(_estW(pl.playlist_name, 14, true), _estW(subLine, 10));
  for (const s of songs.slice(0, 4)) need = Math.max(need, 20 + 22 + 18 + _estW(s && s.title, 12));
  const w = _clampW(210, 270, need);
  const kids = [hstack([
    vstack([iconPaths([{ d: PL_GLYPH_NOTE, f: txt }], { s: 18 })], { w: 30, h: 30, r: 8, bg: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17,17,17,0.08)', al: 'c', jc: 'c', m: [0, 8, 0, 0] }),
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
      playable ? vstack([iconPaths([{ d: PL_GLYPH_PLAY, f: isDark ? '#f5f5f5' : '#111111' }], { s: 12 })], { p: 3, a: `pl_song:${idx}` }) : null,
    ], { p: [3, 0, 3, 0], g: 6, al: 'c', w: -1 }));
  });
  if (songs.length > 4) kids.push(text(`+${songs.length - 4} ${_tr(C, 'chatConv.moreSongs', 'mais')}`, { fs: 10, c: sub, m: [3, 0, 0, 0], ta: 'c', w: -1 }));
  if (songs.length === 0) kids.push(text(_tr(C, 'chatConv.emptyPlaylist', 'Toque pra adicionar músicas'), { fs: 11, c: sub, it: 1, ta: 'c', p: [6, 0, 6, 0], w: -1 }));
  const foot = m._pending
    ? [loader({ s: 12, c: ink }), text(m._plProgress ? `${_tr(C, 'chatConv.playlistAdding', 'Adicionando')} ${m._plProgress}` : _tr(C, 'chatConv.playlistCreating', 'Criando playlist...'), { fs: 10, c: ink, fw: 600 })]
    : [iconPaths([{ d: PL_GLYPH_PENCIL, f: ink }], { s: 11 }), text(_tr(C, 'chatConv.tapToEdit', 'Toque pra editar'), { fs: 10, c: ink, fw: 600 })];
  kids.push(vstack([], { w: -1, h: 0.5, bg: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)', m: [6, 0, 0, 0] }));
  kids.push(hstack(foot, { p: [6, 0, 0, 0], jc: 'c', al: 'c', g: 4, w: -1 }));
  row.bl = [vstack(kids, { w, p: 10, r: 12, bg: isDark ? '#1c1c1e' : '#ffffff', bw: 1, bc: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)', a: 'pl_edit' })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

function buildJsonPlaylist(j, row, C) {
  const col = C.colors || {};
  const n = (j.songs || []).length;
  const prim = col.primary || '#111111';
  const sub = `${n} ${n === 1 ? _tr(C, 'chatConv.song', 'música') : _tr(C, 'chatConv.songs', 'músicas')}`;
  const w = _clampW(240, 300, 24 + 44 + 8 + Math.max(_estW(j.playlist_name, 13, true), _estW(sub, 11)));
  row.bl = [vstack([hstack([
    vstack([iconPaths([{ d: PL_GLYPH_NOTE, f: prim }], { s: 22 })], { w: 44, h: 44, r: 12, bg: /^#[0-9a-f]{6}$/i.test(prim) ? prim + '20' : 'rgba(17,17,17,0.12)', al: 'c', jc: 'c' }),
    vstack([text(String(j.playlist_name || ''), { fs: 13, fw: 600, c: col.text, m: [0, 0, 2, 0] }), text(sub, { fs: 11, c: col.textTertiary })], { fl: 1 }),
  ], { g: 8, al: 'c' })], { w, bg: col.surface, r: 12, p: [10, 12, 10, 12], g: 8 })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

// [2026-10-18 call-card-wa] Glifos CHEIOS do cartão de chamada (viewBox 24,
// só M/L/H/V/C/Z — sem arcos e sem traço). Antes: icon(IconPhone) em traço
// fino com arcos SVG → o founder via só o círculo escuro vazio no balão
// próprio. Cheio + cor explícita = sempre visível (iOS e Android).
const CALL_GLYPH_PHONE = 'M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z';
const CALL_GLYPH_VIDEO = 'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z';

/** Subtítulo estilo WhatsApp: "Sem resposta" / "Perdida" / "Recusada" / "3 min" / "45 s". */
export function callCardSubtitle(cd, own, tr) {
  const st = String((cd && cd.call_status) || '');
  const ds = Math.max(0, Math.round(Number(cd && cd.duration) || 0));
  if (st === 'declined') return tr('call.declined', 'Chamada recusada');
  if (st === 'missed' || st === 'no_answer' || st === 'busy' || st === 'cancelled' || st === 'canceled') {
    return own ? tr('call.noAnswer', 'Sem resposta') : tr('chatConv.missedCall', 'Perdida');
  }
  if (ds > 0) {
    if (ds < 60) return `${ds} s`;
    const mi = Math.round(ds / 60);
    if (mi < 60) return `${mi} min`;
    const h = Math.floor(mi / 60); const r = mi % 60;
    return r ? `${h} h ${r} min` : `${h} h`;
  }
  return '';
}

function buildCallCard(m, row, ctx, C, own) {
  const cd = _json(m.content) || {};
  const col = C.colors || {};
  const isVideo = cd.call_type === 'video';
  const st = String(cd.call_status || '');
  const missed = st === 'missed' || st === 'declined' || st === 'no_answer' || st === 'busy';
  const tr = (k, fb) => _tr(C, k, fb);
  const title = isVideo ? tr('call.videoCall', 'Chamada de vídeo') : tr('call.audioCall', 'Chamada de voz');
  const sub = callCardSubtitle(cd, own, tr);
  // "Ligar" (caixa de frase, como o resto da UI) — não o antigo "LIGAR".
  const btnLbl = tr('chatConv.callContact', 'Ligar');
  // Cores: balão próprio escuro (P&B) → glifo branco em círculo translúcido;
  // recebido → glifo na tinta do texto em círculo cinza suave. Perdida = vermelho.
  const ink = own ? (C.ownText || '#FFFFFF') : (col.text || '#111111');
  const glyphC = missed && !own ? '#E5484D' : ink;
  const circleBg = own ? inkAlpha(C.ownText || '#FFFFFF', 0.16) : (C.isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)');
  const subC = missed && !own ? '#E5484D' : (own ? (C.ownMeta || 'rgba(255,255,255,0.62)') : (C.otherMeta || col.textTertiary));
  // Largura: título SEMPRE numa linha (estimativa folgada + ml:1 trunca se o
  // texto do usuário estiver grande) — nunca mais "Chamada de / voz".
  const btnW = _estW(btnLbl, 14, true) + 28;
  const w = _clampW(236, 300, 40 + 12 + Math.max(_estW(title, 15, true) * 1.12, _estW(sub, 13) * 1.1) + 12 + btnW);
  row.bl = [vstack([hstack([
    vstack([iconPaths([{ d: isVideo ? CALL_GLYPH_VIDEO : CALL_GLYPH_PHONE, f: glyphC }], { s: 20 })], { w: 40, h: 40, r: 20, bg: circleBg, al: 'c', jc: 'c' }),
    vstack([
      text(title, { fs: 15, fw: 600, c: ink, ml: 1 }),
      sub ? text(sub, { fs: 13, c: subC, ml: 1, m: [1, 0, 0, 0] }) : null,
    ], { fl: 1 }),
    vstack([text(btnLbl, { fs: 14, fw: 600, c: own ? (C.ownText || '#FFFFFF') : (C.otherInk || col.text), ml: 1 })], { p: [7, 14, 7, 14], r: 16, bg: own ? inkAlpha(C.ownText || '#FFFFFF', 0.16) : (C.isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)'), a: `call_back:${isVideo ? 'v' : 'a'}` }),
  ], { g: 12, al: 'c', w: -1 })], { w })];
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
    vstack([icon(isVideo ? IconVideo : IconPhone, { s: 16, c: own ? C.ownText : col.text })], { w: 32, h: 32, r: 16, bg: own ? inkAlpha(C.ownText || '#FFFFFF', 0.15) : (C.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'), al: 'c', jc: 'c' }),
    vstack([
      text(isVideo ? _tr(C, 'call.videoCall', 'Videochamada') : _tr(C, 'call.audioCall', 'Chamada de voz'), { fs: 13, fw: 600, c: own ? C.ownText : col.text }),
      text(_tr(C, 'chatConv.tapToJoin', 'Toque para entrar'), { fs: 11, c: own ? C.ownMeta : C.otherMeta }),
    ]),
  ], { g: 8, p: [2, 0, 2, 0], al: 'c', a: 'call_join' })];
  row.pad = PAD; row.mp = 'below';
}

// [call-link 2026-10-19] Cartão do link de chamada (texto "Chamada de vídeo do Chatyy: título\nURL").
// Kill switch: globalThis.__chatyy_call_link_card = false → volta a ser texto com link.
function _clOn() { try { return globalThis.__chatyy_call_link_card !== false; } catch { return true; } }
function _parseCallLink(c) { try { return require('../calls/callLinkUtil').parseCallLinkMessage(c); } catch { return null; } }
function buildCallLinkCard(m, row, C, own) {
  const p = _parseCallLink(String(m.content || ''));
  if (!p) return;
  const col = C.colors || {};
  const tr = (k, fb) => _tr(C, k, fb);
  const ink = own ? (C.ownText || '#FFFFFF') : (col.text || '#111111');
  const subC = own ? (C.ownMeta || 'rgba(255,255,255,0.62)') : (C.otherMeta || col.textTertiary);
  const soft = own ? inkAlpha(C.ownText || '#FFFFFF', 0.16) : (C.isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)');
  const title = p.title || tr('callLink.cardTitle', 'Link de chamada');
  const kind = p.isVideo ? tr('callLink.kindVideo', 'Chamada de vídeo do Chatyy') : tr('callLink.kindVoice', 'Chamada de voz do Chatyy');
  const act = 'clink:' + p.code;
  const w = _clampW(240, 288, 40 + 12 + Math.max(_estW(title, 15, true), _estW(kind, 13)) * 1.1 + 8);
  row.bl = [vstack([
    hstack([
      vstack([iconPaths([{ d: p.isVideo ? CALL_GLYPH_VIDEO : CALL_GLYPH_PHONE, f: ink }], { s: 20 })], { w: 40, h: 40, r: 20, bg: soft, al: 'c', jc: 'c' }),
      vstack([
        text(title, { fs: 15, fw: 600, c: ink, ml: 1 }),
        text(kind, { fs: 13, c: subC, ml: 1, m: [1, 0, 0, 0] }),
      ], { fl: 1 }),
    ], { g: 12, al: 'c', w: -1, a: act }),
    vstack([text(tr('callLink.join', 'Entrar'), { fs: 15, fw: 600, c: ink, ml: 1 })], { w: -1, h: 36, r: 18, bg: soft, al: 'c', jc: 'c', m: [10, 0, 0, 0], a: act }),
  ], { w })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
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
  // [gift-premium 2026-10-16] espelho do GiftBubble JS: palco escuro com a arte
  // em destaque, "Você enviou ◇N a Fulano" (diamante monocromático), recado e
  // "Agradecer" (ação gift_thank) para quem recebe. Estático no nativo.
  let gc = null; let fx = null;
  try { gc = require('../gifts/giftCatalog'); } catch { gc = null; }
  try { fx = require('../gifts/giftFx'); } catch { fx = null; }
  const col = C.colors || {};
  const j = (gc && gc.parseGiftContent(m.content)) || {};
  const meta = gc ? gc.giftMeta(j.gift_sku || '') : { icon: 'gift', label: 'gift', diamonds: 1 };
  const ic = j.icon || meta.icon;
  const qty = Math.max(1, Number(j.quantity) || 1);
  const diamonds = Number(j.diamonds) || (Number(j.unit_diamonds) || meta.diamonds) * qty;
  const label = gc ? gc.giftLabel(C.t, ic, j.label || meta.label) : String(j.label || meta.label);
  const textColor = own ? C.ownText : col.text;
  const subColor = own ? C.ownText : (col.textSecondary || col.text);
  const fbOwn = _tr(C, 'gifts.youSent', 'Você enviou um presente');
  const fbOther = _tr(C, 'gifts.youReceived', 'Enviou um presente para você');
  const parts = fx ? fx.giftHeadParts(C.t, own, own ? j.to_name : j.from_name, fbOwn, fbOther) : { before: own ? fbOwn : fbOther, after: '' };
  const note = typeof j.note === 'string' ? j.note.trim() : '';
  const big = /^(large|legendary)$/.test(String(j.tier || meta.tier || ''));
  const glyph = _giftGlyph(ic, big ? 84 : 76);
  const cost = gc ? gc.humanizeCount(diamonds) : String(diamonds);
  const chipBg = own ? 'rgba(255,255,255,0.14)' : 'rgba(127,127,127,0.14)';
  const dia = fx ? iconPaths(fx.diamondMonoPaths(textColor), { s: 12 }) : icon(IconDiamond, { s: 12, c: '#60a5fa' });
  // Palco = GiftBubble JS (estático): halo + anel fino, arte grande no centro,
  // 3 brilhos (sparkle) fixos, selo ×N. Fallback sem arte: caixa de presente.
  const spark = (sz) => iconPaths([{ d: 'M12 1.5c.7 5.6 4.9 9.8 10.5 10.5-5.6.7-9.8 4.9-10.5 10.5C11.3 16.9 7.1 12.7 1.5 12 7.1 11.3 11.3 7.1 12 1.5Z', f: '#ffffff' }], { s: sz });
  const art = glyph || _giftGlyph('gift', big ? 84 : 76);
  const stage = zstack([
    vstack([], { w: 220, h: 132, r: 18, bg: '#0b0b0b' }),
    vstack([], { pos: 'c', w: 180, h: 180, r: 90, bw: 1, bc: 'rgba(255,255,255,0.06)' }),
    vstack([], { pos: 'c', w: big ? 128 : 118, h: big ? 128 : 118, r: 64, bg: big ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.06)' }),
    art ? vstack([art], { pos: 'c' }) : null,
    vstack([spark(11)], { pos: 'tl', m: [18, 0, 0, 52], op: 0.85 }),
    vstack([spark(8)], { pos: 'tr', m: [30, 56, 0, 0], op: 0.5 }),
    vstack([spark(9)], { pos: 'br', m: [0, 46, 22, 0], op: 0.7 }),
    qty > 1 ? vstack([text(`×${qty}`, { fs: 12, fw: 900, c: '#000000' })], { pos: 'tr', m: [10, 10, 0, 0], h: 22, r: 11, p: [0, 8, 0, 8], bg: '#FFFFFF', al: 'c', jc: 'c' }) : null,
  ], { m: [0, 0, 10, 0], r: 18 });
  const kids = [
    stage,
    text(label, { fs: 17, fw: 800, c: textColor, ml: 1, ta: 'c' }),
    hstack([
      parts.before ? text(parts.before, { fs: 12.5, fw: 600, c: subColor, ml: 1 }) : null,
      hstack([dia, text(cost, { fs: 12.5, fw: 800, c: textColor })], { g: 4, al: 'c', h: 20, r: 10, p: [0, 7, 0, 7], bg: chipBg, m: [0, 4, 0, 4] }),
      parts.after ? text(parts.after, { fs: 12.5, fw: 600, c: subColor, ml: 1 }) : null,
    ], { al: 'c', m: [4, 0, 0, 0] }),
  ];
  if (note) kids.push(vstack([text(note, { fs: 14.5, lh: 19, it: 1, c: textColor })], { w: -1, r: 12, bg: chipBg, p: [8, 10, 8, 10], m: [10, 0, 0, 0] }));
  if (!own) {
    const heart = iconPaths([{ d: 'M12 20.5s-7.5-4.6-9.2-9.4C1.6 7.6 3.7 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.5 0 5.6 3.6 4.4 7.1-1.7 4.8-9.2 9.4-9.2 9.4Z', k: textColor, w: 1.9 }], { s: 15 });
    kids.push(hstack([heart, text(_tr(C, 'gifts.thank', 'Agradecer'), { fs: 14, fw: 700, c: textColor })], {
      w: -1, h: 36, r: 18, bw: 1.2, bc: textColor, al: 'c', jc: 'c', g: 6, m: [10, 0, 0, 0], a: 'gift_thank',
    }));
  }
  row.bl = [vstack(kids, { al: 'c', p: [6, 6, 2, 6], w: 232 })];
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
  const snippet = String(st.content || '').split('\n')[0] || '';
  // own = EU mandei → "Você respondeu"; o dono do status vê "Respondeu ao seu status".
  const label = isReaction
    ? (own ? _tr(C, 'status.youReactedToStatus', 'Você reagiu ao status') : _tr(C, 'status.reactedToYourStatus', 'Reagiu ao seu status'))
    : (own ? _tr(C, 'status.replyToOwner', 'Você respondeu ao status') : _tr(C, 'status.replyFromOwner', 'Respondeu ao seu status'));
  const isImage = st.type === 'image'; const isVideo = st.type === 'video';
  const fb = isImage ? _tr(C, 'status.typePhoto', 'Foto') : isVideo ? _tr(C, 'status.typeVideo', 'Vídeo') : '';
  const accent = own ? inkAlpha(C.ownText || '#FFFFFF', 0.85) : C.otherInk; // [2026-10-21 polish-conv] tinta da bolha (balão claro na cor do destaque)
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
  const sub = own ? inkAlpha(C.ownText || '#FFFFFF', 0.85) : col.textSecondary;
  const info = [text(label, { fs: 11, fw: 700, c: accent, m: [0, 0, 2, 0], ls: 0.2 })];
  if (snippet) info.push(text(snippet, { fs: 12.5, c: sub, ml: 2 }));
  else if (fb) {
    info.push(hstack([
      isImage ? icon(IconImage, { s: 13, c: own ? inkAlpha(C.ownText || '#FFFFFF', 0.8) : col.textSecondary }) : isVideo ? icon(IconVideo, { s: 13, c: own ? inkAlpha(C.ownText || '#FFFFFF', 0.8) : col.textSecondary }) : null,
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
    ], { w: -1, r: 10, bg: own ? inkAlpha(C.ownText || '#FFFFFF', 0.12) : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'), m: [0, 0, 6, 0], a: 'st_open' }),
    rt,
  ];
  row.cw = w; row.pad = PAD; row.mp = 'in';
}

function buildViewOnce(m, row, ctx, C, own) {
  // [2026-10-21 view-once WA] Visual WhatsApp, glifos por PATHS crus (iconPaths,
  // components/chat/viewOnceGlyphs.js) — nunca mais "círculo cinza vazio":
  //   enviando → anel de progresso (_uploadPct) ou spinner nativo (indeterminado)
  //   enviada  → "1" em círculo tracejado · aberta/expirada → círculo com ✓
  //   recebida não aberta → "1" tracejado + "Toque para ver" (vo_open)
  // Sem fundo circular: se o glifo faltasse, não sobraria disco vazio.
  const col = C.colors || {};
  const V = _viewOnce(m, ctx);
  const title = V.isAudio ? _tr(C, 'chatConv.viewOnceVoiceLabel', 'Áudio único') : V.isVideo ? _tr(C, 'chatConv.viewOnceVideo', 'Vídeo único') : _tr(C, 'chatConv.viewOncePhoto', 'Foto única');
  const S = viewOnceState(m, own, V.locked, V.anyViewed);
  const ink = own ? (C.ownText || '#FFFFFF') : (C.otherInk || col.text || '#111111');
  const subtle = own ? (C.ownMeta || inkAlpha(ink, 0.6)) : (col.textSecondary || C.otherMeta || '#666666');
  let glyph = null; let sub; let glyphInk = ink; let action;
  if (S.st === 'sending') {
    sub = _tr(C, 'chatConv.sending', 'Enviando...');
    glyph = S.pct != null
      ? iconPaths(viewOnceRingPaths(Math.max(0.04, S.pct), ink, inkAlpha(ink, 0.25)), { s: 24 })
      : loader({ s: 20, c: ink });
  } else if (S.st === 'opened') {
    sub = V.isAudio && !own ? _tr(C, 'chatConv.viewOnceVoiceExpired', 'Áudio expirado') : _tr(C, 'chatConv.viewOnceOpened', 'Aberta');
    glyphInk = subtle;
    glyph = iconPaths(viewOncePaths('opened', glyphInk), { s: 24 });
  } else if (S.st === 'unopened') {
    sub = _tr(C, 'chatConv.tapToView', 'Toque para ver');
    glyphInk = col.primary || ink;
    glyph = iconPaths(viewOncePaths('one', glyphInk), { s: 24 });
    action = 'vo_open';
  } else {
    sub = _tr(C, 'chatConv.viewOnceSent', 'Visualização única');
    glyph = iconPaths(viewOncePaths('one', ink), { s: 24 });
  }
  const titleInk = S.st === 'opened' ? subtle : ink;
  const w = _clampW(170, 260, 28 + 10 + Math.max(_estW(title, 14, true), _estW(sub, 12)) + 8);
  const o = { g: 10, al: 'c', p: [6, 4, 6, 0], w };
  if (action) o.a = action;
  row.bl = [hstack([
    vstack([glyph], { w: 28, h: 28, al: 'c', jc: 'c' }),
    vstack([
      text(title, { fs: 14, fw: 600, c: titleInk, ml: 1 }),
      text(sub, { fs: 12, c: subtle, it: S.st === 'opened' ? 1 : 0, ml: 1, m: [1, 0, 0, 0] }),
    ], { fl: 1 }),
  ], o)];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

// ─── [2026-10-16 native-cover] correio de voz / figurinha animada / fallback por LINHA ──
// Toque ('jsrow') abre a versão JS da linha numa folha (NativeRowSheet no
// chat-conversation) — o resto da conversa continua na lista nativa.
function _durMS(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function buildVoicemail(m, row, C, own) {
  const col = C.colors || {};
  const vm = _json(m.content);
  const ink = own ? C.ownText : col.text;
  const meta = own ? C.ownMeta : (col.textTertiary || C.otherMeta);
  if (!vm || !vm.voicemail_id) {
    row.bl = [text(_tr(C, 'voicemail.unavailable', 'Mensagem de voz indisponível'), { fs: 15, c: ink, it: 1, mi: 1 })];
    row.pad = PAD; row.mp = 'in';
    return;
  }
  const title = _tr(C, 'voicemail.title', 'Mensagem de voz');
  const sub = `${_tr(C, 'voicemail.afterMissedCall', 'Após chamada perdida')} · ${_durMS(vm.duration || vm.duration_sec)}`;
  const play = _tr(C, 'voicemail.tapToPlay', 'Tocar mensagem');
  const tx = m.voicemail_transcription || vm.transcription || '';
  const pillBg = own ? 'rgba(127,127,127,0.18)' : (C.isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)');
  const kids = [
    hstack([
      icon(IconMic, { s: 18, c: ink }),
      vstack([text(title, { fs: 13, fw: 700, c: ink, ml: 1 }), text(sub, { fs: 11, c: meta, ml: 1 })], { fl: 1 }),
    ], { g: 8, al: 'c', m: [0, 0, 6, 0] }),
    hstack([
      vstack([icon(IconPlay, { s: 16, c: C.isDark && !own ? '#111111' : '#FFFFFF' })], { w: 36, h: 36, r: 18, bg: C.isDark && !own ? '#F5F5F7' : '#111111', al: 'c', jc: 'c' }),
      text(play, { fs: 13, c: ink, fl: 1, ml: 1 }),
    ], { g: 10, al: 'c', p: [8, 12, 8, 8], r: 18, bg: pillBg, w: -1 }),
  ];
  if (tx) kids.push(text(`${_tr(C, 'voicemail.transcriptionPrefix', 'Transcrição:')} ${tx}`, { fs: 12, it: 1, lh: 16, c: own ? C.ownText : (col.textSecondary || col.text), m: [8, 0, 0, 0], ml: 6 }));
  row.bl = [vstack(kids, { w: 260, p: [2, 0, 2, 0], a: 'jsrow' })];
  row.cw = 260; row.pad = PAD; row.mp = 'below';
}
function buildLottie(m, row, C) {
  // [2026-10-16 mascote] saudação do mascote → quadro estático (PNG) na lista
  // nativa; toque abre a linha JS (mascote animado) na folha.
  const _mu = String(m.file_url || m.content || '');
  if (/\/stickers\/chatyy-[a-z]+\.json(?:[?#].*)?$/i.test(_mu)) {
    row.bl = [image(_mu.replace(/\.json(?=[?#]|$)/i, '.png'), { w: 150, h: 150, fit: 'contain', a: 'jsrow' })];
    row.cw = 150; row.bare = 1; row.pad = [0, 0, 0, 0]; row.mp = 'below';
    return;
  }
  const ink = C.isDark ? '#F5F5F7' : '#111111';
  row.bl = [vstack([
    icon(IconFilm, { s: 44, c: ink }),
    text(_tr(C, 'chatConv.nlAnimatedSticker', 'Figurinha animada'), { fs: 11, fw: 600, c: ink, ml: 1, m: [6, 0, 0, 0], ta: 'c' }),
  ], { w: 120, h: 120, r: 16, bg: C.isDark ? 'rgba(255,255,255,0.10)' : 'rgba(17,17,17,0.08)', al: 'c', jc: 'c', a: 'jsrow' })];
  row.cw = 120; row.bare = 1; row.pad = [0, 0, 0, 0]; row.mp = 'below';
}

/**
 * Linha que o nativo não sabe desenhar → cartão-resumo (ícone + tipo + trecho)
 * com toque 'jsrow' (abre a versão JS em folha). Nunca derruba a conversa.
 * Devolve true quando preencheu row.bl.
 */
// [jogos 2026-10-18] Cartão de jogo (convite / em andamento / resultado com pódio) — espelho do
// components/games/GameChatCard.js. Ações: game:<open|play|watch|accept|decline|join|start|cancel|rematch>.
function buildGame(m, row, ctx, C, own) {
  const G = require('../../services/games');
  const g = G.parseGameContent(m.content);
  if (!g) return;
  const P = _palette(own, C); const col = P.col;
  const ink = own ? C.ownText : (col.text || '#111111');
  const sub = own ? C.ownMeta : (col.textSecondary || C.otherMeta || '#6b7280');
  const line = own ? inkAlpha(C.ownText || '#FFFFFF', 0.18) : (C.isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'); // [2026-10-21 contraste]
  const tf = (k, opts) => { try { return C.t ? C.t(k, opts) : (opts && opts.defaultValue) || k; } catch { return (opts && opts.defaultValue) || k; } };
  // [2026-10-20 dock-imersivo] partida aberta no painel → 1 linha compacta (o jogo está logo abaixo)
  try {
    const GI = require('../../services/gamesInline');
    _gameHookBump(C);
    if (g.kind === 'game' && GI.gamesInlineOn() && GI.dockedGameId() === Number(g.g)) {
      const w0 = 236;
      row.bl = [hstack([
        vstack([icon(_gameIconComp(g.type), { s: 13, c: '#FFFFFF' })], { w: 24, h: 24, r: 7, bg: '#0B0B0C', al: 'c', jc: 'c' }),
        vstack([
          text(G.tr(tf, 'games.dock.inProgress', 'Partida em andamento'), { fs: 13.5, fw: 700, c: ink, ml: 1 }),
          text(G.gameTitle(tf, g.type) + ' · ' + G.tr(tf, 'games.dock.belowHint', 'aberta abaixo'), { fs: 11.5, c: sub, ml: 1 }),
        ], { fl: 1 }),
      ], { w: w0, g: 9, al: 'c', p: [7, 10, 7, 8], a: 'game:play' })];
      row.cw = w0; row.pad = PAD; row.mp = 'below';
      return;
    }
  } catch {}
  const me = ctx.myEmail || '';
  const isRes = g.kind === 'result';
  const w = 268;
  let acts = G.gameCardActions(g, me);
  const openAct = acts.includes('play') ? 'play' : (acts.includes('watch') ? 'watch' : 'open');
  const myTurn = G.isMyTurn(g, me);
  const badge = G.gameEndBadge ? G.gameEndBadge(tf, g, me) : null; // [jogos 2026-10-19]
  const acc = '#0B0B0C'; // [2026-10-20 dock-imersivo] P&B: cor do jogo só nas cartas/peças
  const BADGE_BG = { won: '#16A34A', resigned_other: '#16A34A', abandoned: '#B45309', draw: 'rgba(255,255,255,0.22)' };
  const head = hstack([
    vstack([icon(isRes ? _IconGameTrophy : _gameIconComp(g.type), { s: 18, c: '#FFFFFF' })], { w: 34, h: 34, r: 10, bg: 'rgba(255,255,255,0.14)', al: 'c', jc: 'c' }),
    vstack([
      text(G.gameTitle(tf, g.type), { fs: 15, fw: 800, c: '#FFFFFF', ml: 1 }),
      text(isRes ? G.tr(tf, 'games.resultLabel', 'Resultado') : G.tr(tf, 'games.cardLabel', 'Jogo na conversa'), { fs: 11, c: 'rgba(255,255,255,0.7)', ml: 1 }),
    ], { fl: 1 }),
    myTurn ? hstack([vstack([], { w: 6, h: 6, r: 3, bg: acc }), text(G.tr(tf, 'games.status.yourTurn', 'Sua vez'), { fs: 11, fw: 800, c: '#000000' })], { bg: '#FFFFFF', r: 11, p: [3, 8, 3, 8], g: 5, al: 'c' }) : null,
    // [jogos 2026-10-19] estado final: Cancelado · Expirado · Recusado · Empate · Venceu · Perdeu · Abandonou
    (!myTurn && badge) ? vstack([text(badge.label, { fs: 11, fw: 800, c: '#FFFFFF' })], { bg: BADGE_BG[badge.kind] || 'rgba(255,255,255,0.16)', r: 10, p: [3, 8, 3, 8] }) : null,
  ], { w: -1, bg: isRes ? '#000000' : '#0B0B0C', p: [10, 12, 10, 12], g: 10, al: 'c', a: 'game:' + openAct });
  const headBar = head;
  const body = [];
  if (isRes) {
    body.push(text(G.resultHeadline(tf, g, me), { fs: 15, fw: 800, c: ink, lh: 20, m: [0, 0, 6, 0] }));
    if ((g.type === 'forca' || g.type === 'termo') && g.word) body.push(text(G.tr(tf, 'games.forca.wordWas', 'A palavra era {w}', { w: g.word }), { fs: 12, c: sub, m: [0, 0, 4, 0] }));
    const rk = Array.isArray(g.ranking) ? g.ranking.slice(0, 3) : [];
    const showSc = g.type === 'quiz' || g.type === 'forca' || ['ppt', 'stop', 'desenho'].includes(g.type); // [jogos2b]
    if (rk.length > 1) rk.forEach((r, i) => {
      body.push(hstack([
        text(String(i + 1), { fs: 13, fw: 800, c: i === 0 ? ink : sub, w: 14, ta: 'c' }),
        _avatarNode(r.n, r.e, 22),
        text(G.nameOf(g, r.e, me, tf), { fs: 13.5, fw: i === 0 ? 700 : 500, c: ink, fl: 1, ml: 1 }),
        showSc ? text(G.tr(tf, 'games.points', '{n} pts', { n: r.sc }), { fs: 12, fw: 600, c: sub }) : null,
      ], { w: -1, g: 8, al: 'c', p: [6, 0, 6, 0] }));
    });
  } else {
    const pls = (Array.isArray(g.players) ? g.players : []).filter((p) => g.status === 'pending' || p.s === 'accepted' || p.s === 'left').slice(0, 6);
    body.push(hstack(pls.map((p) => {
      const lc = String(p.e || '').toLowerCase();
      const turn = g.status === 'active' && String(g.turn || '').toLowerCase() === lc;
      const win = Array.isArray(g.winners) && g.winners.some((x) => String(x).toLowerCase() === lc);
      return vstack([
        vstack([_avatarNode(p.n, p.e, 22)], (turn || win) ? { bw: 2, bc: ink, r: 14, p: 1 } : { p: 3 }),
        text(G.nameOf(g, p.e, me, tf), { fs: 11, fw: 600, c: ink, ml: 1, m: [3, 0, 0, 0] }),
        g.status === 'pending' ? text(G.playerStatusLabel(tf, p.s), { fs: 9.5, c: sub, ml: 1 }) : null,
      ], { w: 54, al: 'c' });
    }), { g: 10, m: [0, 0, 8, 0] }));
    body.push(text(G.gameStatusLine(tf, g, me), { fs: 14.5, fw: 700, c: ink, ml: 2 }));
  }
  // [jogos 2026-10-19 inline] tabuleiro tocável no próprio cartão (Velha/Forca/Quiz) ou miniatura (Damas/Cartas)
  const board = _gameInlineNodes(g, ctx, C, tf, me);
  let kids;
  if (board) {
    kids = [headBar, board, vstack([body[body.length - 1]], { w: -1, p: [8, 12, 8, 12], a: 'game:' + openAct })];
    if (require('../../services/gamesInline').isInlineType(g.type)) acts = acts.filter((a) => a !== 'play' && a !== 'watch');
  } else kids = [headBar, vstack(body, { w: -1, p: [10, 12, 8, 12], a: 'game:' + openAct })];
  if (acts.length) {
    const primary = { accept: 1, join: 1, start: 1, play: 1, rematch: 1 };
    kids.push(vstack([], { w: -1, h: 0.5, bg: line }));
    kids.push(hstack(acts.slice(0, 3).map((a) => {
      const prim = !!primary[a];
      // [2026-10-21 contraste] balão próprio: botão na TINTA do balão (luminância), não branco fixo
      const pbg = own ? (C.ownText || '#FFFFFF') : (C.isDark ? '#FFFFFF' : '#111111');
      const pfg = own ? onInk(pbg) : (C.isDark ? '#111111' : '#FFFFFF');
      return vstack([text(_gameActLabel(G, tf, a, g, me), { fs: 13.5, fw: 700, c: prim ? pfg : ink })], {
        fl: 1, p: [8, 0, 8, 0], r: 10, al: 'c', bg: prim ? pbg : undefined, bw: prim ? 0 : 1, bc: prim ? undefined : line, a: 'game:' + a,
      });
    }), { w: -1, g: 8, p: [9, 10, 9, 10] }));
  }
  row.bl = [vstack(kids, { w, r: 16, m: [1, 0, 1, 0] })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

// ─── [jogos 2026-10-19 inline] jogo DENTRO do cartão na lista nativa ───────────────────────────────
// Espelho de components/games/GameInlineBoard.js com nós tocáveis (`a`): game:mv:<casa> (Velha),
// game:l:<letra> (Forca), game:q:<opção> (Quiz) → runCardAction → services/gamesInline.runInlineAction.
// A visão (state) vem do store do WS; quando falta, é buscada 1× e o cartão re-monta via cards.bump().
// Sem build: só nós v/h/tx/ic que o binário já desenha. Kill: globalThis.__chatyy_games_inline = false.
let _gameBumpFn = null;
let _gameBumpOff = null;
function _gameHookBump(C) {
  if (C && typeof C.bump === 'function') _gameBumpFn = C.bump;
  if (_gameBumpOff) return;
  try {
    _gameBumpOff = require('../../services/gamesInline').onInlineChange((id, why) => {
      if (why === 'sec') return; // relógio de 1 s do Quiz: só o render JS (re-montar a lista nativa a cada segundo pesa)
      try { _gameBumpFn && _gameBumpFn(); } catch {}
    });
  } catch {}
}
function _gameActLabel(G, tf, a, g, me) {
  try {
    const GI = require('../../services/gamesInline');
    if (GI.gamesInlineOn() && a === 'rematch' && !(g && g.rematch_st === 'pending' && g.rematch_by && String(g.rematch_by).toLowerCase() !== String(me || '').toLowerCase())) return G.tr(tf, 'games.act.playAgain', 'Jogar de novo');
  } catch {}
  return G.gameActionLabel(tf, a, g, me);
}
const _GX = [{ d: 'M6.5 6.5l11 11M17.5 6.5l-11 11' }];
const _GO = [{ d: 'M12 4.8a7.2 7.2 0 1 1 0 14.4a7.2 7.2 0 1 1 0-14.4z' }];
const _KB = ['ABCDEFG', 'HIJKLMN', 'OPQRSTU', 'VWXYZ'];
const _CARD_BG = { r: '#E5484D', y: '#F0B400', g: '#22A55B', b: '#2F6FEB', W: '#141416' };
function _gNorm(ch) { return String(ch || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase(); }
function _gameInlineNodes(g, ctx, C, tf, me) {
  let GI;
  try { GI = require('../../services/gamesInline'); } catch { return null; }
  if (!GI.gamesInlineOn() || g.kind !== 'game' || (g.status !== 'active' && g.status !== 'finished')) return null;
  _gameHookBump(C);
  const v = GI.ensureInlineView(g.g, g.status, g.v);
  if (!v || !v.state) return null;
  const active = v.status === 'active';
  if (!active && !(v.status === 'finished' && (v.type === 'velha' || v.type === 'forca'))) return null;
  const dark = !!C.isDark;
  const ink = dark ? '#FFFFFF' : '#0A0A0A';
  const sub = dark ? '#A1A1AA' : '#6B7280';
  const card = dark ? '#1E1E21' : '#F1F1F3';
  const card2 = dark ? '#2A2A2E' : '#E4E4E7';
  const strong = ink; const onStrong = dark ? '#0A0A0A' : '#FFFFFF';
  const good = '#16A34A'; const bad = '#DC2626';
  const accent = dark ? 'rgba(255,214,10,0.30)' : 'rgba(224,168,0,0.24)';
  const S = v.state || {};
  const busy = GI.inlineBusy(v.g);
  const pend = GI.inlinePending(v.g);
  const err = GI.inlineError(v.g);
  const kids = [];
  if (v.type === 'velha') {
    const b = Array.isArray(S.b) ? S.b : Array(9).fill('');
    const legal = new Set(Array.isArray(S.legal) ? S.legal : []);
    const win = new Set(Array.isArray(S.line) ? S.line : []);
    const last = S.last && Number.isInteger(S.last.cell) ? S.last.cell : -1;
    const CELL = 66;
    const rows = [0, 1, 2].map((r) => hstack([0, 1, 2].map((c) => {
      const i = r * 3 + c;
      let m = b[i];
      if (!m && pend && pend.kind === 'cell' && pend.val === i) m = v.me === 0 ? 'X' : 'O';
      const can = active && legal.has(i) && !busy && !m;
      const mk = m === 'X' ? iconPaths(_GX.map((x) => ({ d: x.d, k: ink, w: 2.6 })), { s: 40 })
        : m === 'O' ? iconPaths(_GO.map((x) => ({ d: x.d, k: ink, w: 2.4 })), { s: 40 })
          : (can ? vstack([], { w: 7, h: 7, r: 4, bg: card2 }) : null);
      return vstack(mk ? [mk] : [], { w: CELL, h: CELL, r: 14, al: 'c', jc: 'c', bg: win.has(i) ? accent : (i === last ? card2 : card), a: can ? 'game:mv:' + i : undefined });
    }), { g: 6 }));
    kids.push(vstack(rows, { g: 6, al: 'c', w: -1 }));
  } else if (v.type === 'forca') {
    const mask = Array.isArray(S.mask) ? S.mask : [];
    const guessed = new Set((S.g || []).map(_gNorm));
    const shown = new Set(mask.filter(Boolean).map(_gNorm));
    const myTurn = active && v.me !== null && v.me !== undefined && S.turn === v.me;
    const max = S.max || 6; const wrong = S.wrong || 0;
    kids.push(hstack([
      S.cat ? vstack([text(S.cat, { fs: 11, fw: 700, c: ink, ml: 1 })], { bw: 1, bc: card2, r: 7, p: [2, 7, 2, 7] }) : null,
      spacer({ fl: 1 }),
      text(G_tr(tf, 'games.forca.errors', '{n} de {max} erros', { n: wrong, max }), { fs: 11.5, fw: 700, c: wrong >= max - 1 ? bad : sub }),
    ], { w: -1, al: 'c', m: [0, 0, 6, 0] }));
    kids.push(hstack(Array.from({ length: max }).map((_, k) => vstack([], { fl: 1, h: 4, r: 2, bg: k < wrong ? bad : card2 })), { w: -1, g: 3 }));
    const word = mask.map((ch) => (ch === ' ' || ch === '-' ? (ch === '-' ? '-' : ' ') : (ch || '_'))).join(' ');
    kids.push(text(word, { fs: mask.length > 10 ? 17 : 21, fw: 900, c: v.status === 'finished' ? (S.hanged ? bad : good) : ink, ta: 'c', w: -1, m: [10, 0, 10, 0] }));
    if (active) {
      _KB.forEach((row) => {
        kids.push(hstack(row.split('').map((L) => {
          const used = guessed.has(L);
          const hit = used && shown.has(L);
          const isP = pend && pend.kind === 'letter' && pend.val === L;
          const can = myTurn && !used && !busy;
          return vstack([text(L, { fs: 13.5, fw: 800, c: hit || isP ? onStrong : ink })], {
            w: 30, h: 32, r: 8, al: 'c', jc: 'c', bg: hit || isP ? strong : (used ? undefined : card), bw: used && !hit ? 1 : 0, bc: used && !hit ? card2 : undefined,
            op: used && !hit ? 0.4 : (myTurn ? 1 : 0.7), a: can ? 'game:l:' + L : undefined,
          });
        }), { g: 4, jc: 'c', w: -1, m: [0, 0, 4, 0] }));
      });
    } else if (S.word) kids.push(text(G_tr(tf, 'games.forca.wordWas', 'A palavra era {w}', { w: S.word }), { fs: 12, c: sub, ta: 'c', w: -1 }));
  } else if (v.type === 'quiz') {
    const isPlayer = v.me !== null && v.me !== undefined && !(S.out && S.out[v.me]);
    const myChoice = S.my ? S.my.c : (pend && pend.kind === 'answer' && pend.q === S.i ? pend.val : null);
    const answered = myChoice !== null && myChoice !== undefined;
    const reveal = S.ph !== 'q';
    kids.push(text(G_tr(tf, 'games.quiz.progress', 'Pergunta {i} de {n}', { i: (S.i || 0) + 1, n: S.count || 10 }), { fs: 11.5, fw: 700, c: sub, m: [0, 0, 6, 0] }));
    kids.push(text(S.q || '', { fs: 15, fw: 800, c: ink, lh: 20, m: [0, 0, 8, 0] }));
    (S.o || []).forEach((o, i) => {
      const right = reveal && i === S.a;
      const mineWrong = reveal && myChoice === i && i !== S.a;
      const chosen = myChoice === i;
      const can = isPlayer && !reveal && !answered && !busy;
      const fg = right ? '#FFFFFF' : (chosen && !reveal ? onStrong : ink);
      kids.push(hstack([
        text(['A', 'B', 'C', 'D'][i] || '', { fs: 13.5, fw: 900, c: fg, w: 16 }),
        text(o, { fs: 13.5, fw: 600, c: fg, fl: 1, ml: 2 }),
      ], { w: -1, g: 8, al: 'c', r: 11, p: [9, 10, 9, 10], m: [0, 0, 6, 0], bg: right ? good : (chosen && !reveal ? strong : card), bw: mineWrong ? 2 : 0, bc: mineWrong ? bad : undefined, op: reveal && !right && !chosen ? 0.5 : 1, a: can ? 'game:q:' + i : undefined }));
    });
    kids.push(text(!reveal
      ? (answered ? G_tr(tf, 'games.inline.answered', 'Resposta enviada') : (isPlayer ? G_tr(tf, 'games.quiz.answerFast', 'Responda rápido: vale mais pontos') : G_tr(tf, 'games.spectating', 'Você está assistindo')))
      : (S.my && S.my.pts > 0 ? G_tr(tf, 'games.quiz.gotPts', 'Certa! +{n} pontos', { n: S.my.pts }) : (S.my ? G_tr(tf, 'games.quiz.wrong', 'Não foi desta vez') : G_tr(tf, 'games.quiz.next', 'Próxima pergunta já vem'))),
    { fs: 12, fw: reveal ? 800 : 500, c: reveal && S.my && S.my.pts > 0 ? good : sub, ta: 'c', w: -1 }));
  } else if (v.type === 'damas') {
    const bd = typeof S.bd === 'string' && S.bd.length === 64 ? S.bd : '.'.repeat(64);
    const flip = v.me === 1;
    const lastSet = new Set(S.last && Array.isArray(S.last.p) ? [S.last.p[0], S.last.p[S.last.p.length - 1]] : []);
    const CL = 18;
    const lightSq = dark ? '#5B5B60' : '#EDEDED'; const darkSq = dark ? '#1E1E21' : '#3C3C3F';
    const rows = [];
    for (let r = 0; r < 8; r++) {
      const cells = [];
      for (let c = 0; c < 8; c++) {
        const k = r * 8 + c; const sq = flip ? 63 - k : k; const ch = bd[sq];
        const piece = ch && ch !== '.' ? vstack([], { w: 13, h: 13, r: 7, bg: ch === 'w' || ch === 'W' ? '#F4F1EA' : '#151517', bw: ch === 'W' || ch === 'B' ? 2 : 1, bc: ch === 'W' || ch === 'B' ? '#E0A800' : (ch === 'w' ? '#B9B4A8' : '#5A5A60') }) : null;
        cells.push(vstack(piece ? [piece] : [], { w: CL, h: CL, al: 'c', jc: 'c', bg: lastSet.has(sq) ? accent : ((r + c) % 2 ? darkSq : lightSq) }));
      }
      rows.push(hstack(cells, {}));
    }
    kids.push(vstack([vstack(rows, { bw: 3, bc: dark ? '#2C2C2E' : '#0A0A0A', r: 6 })], { w: -1, al: 'c', a: 'game:play' }));
  } else if (v.type === 'cartas') {
    const top = String(S.top || '');
    const val = top.slice(1);
    const lbl = top === 'WW' ? '' : top === 'W4' ? '+4' : val === 'D' ? '+2' : val === 'S' ? G_tr(tf, 'games.cartas.skip', 'Pular') : val === 'R' ? G_tr(tf, 'games.cartas.reverse', 'Inverter') : val;
    const seats = Array.isArray(v.seats) ? v.seats : [];
    const counts = Array.isArray(S.counts) ? S.counts : [];
    const info = [];
    if (Array.isArray(S.hand)) info.push(text(G_tr(tf, 'games.inline.yourCards', 'Você tem {n} cartas', { n: S.hand.length }), { fs: 13.5, fw: 800, c: ink }));
    seats.forEach((e, i) => { if (i !== v.me) info.push(text(`${require('../../services/games').nameOf(v, e, me, tf)} · ${G_tr(tf, 'games.cartas.nShort', '{n} c.', { n: counts[i] ?? 0 })}`, { fs: 12, c: sub, ml: 1 })); });
    kids.push(hstack([
      top ? vstack([text(lbl || 'W', { fs: lbl.length > 2 ? 11 : 20, fw: 800, c: '#FFFFFF', ta: 'c' })], { w: 48, h: 70, r: 8, al: 'c', jc: 'c', bg: _CARD_BG[top[0]] || '#777777', bw: 1, bc: 'rgba(255,255,255,0.35)' }) : null,
      vstack(info, { fl: 1, g: 3 }),
    ], { w: -1, g: 14, al: 'c', a: 'game:play' }));
  }
  // [jogos2 2026-10-21] Ligue 4 / Batalha Naval / Dominó / Memória: miniatura ao vivo (abre no painel)
  if (!kids.length) {
    try {
      const J2 = require('../games/jogos2Thumbs');
      if (J2.JOGOS2_TYPES[v.type]) { const nd = J2.jogos2NativeNodes(v, { vstack, hstack, text }, { dark, ink, sub, accentSolid: dark ? '#FFD60A' : '#E0A800' }, tf, me); if (nd) kids.push(nd); }
    } catch {}
  }
  if (!kids.length) return null;
  if (err) kids.push(text(err, { fs: 12, fw: 700, c: bad, ta: 'c', w: -1, m: [4, 0, 0, 0] }));
  return vstack(kids, { w: -1, p: [10, 12, 6, 12], bg: dark ? '#000000' : '#FFFFFF' });
}
function G_tr(tf, k, fb, vars) { try { return require('../../services/games').tr(tf, k, fb, vars); } catch { return fb; } }

// [loc-pedido 2026-10-19] Pedido de localização — espelho de components/chat/LocationRequestCard.js.
// Ações: lr:share · lr:decline (quem recebeu) · lr:cancel (quem pediu).
function _lrOn() { try { return require('../../services/locationRequest').locReqEnabled(); } catch { return false; } }
function buildLocReq(m, row, ctx, C, own) {
  // [loc-pedido v2 2026-10-19] Palco escuro com mapa P&B (ruas, avenidas, quarteirões, via diagonal),
  // anéis de pulso e pino grande no centro — só nós v/z + iconPaths (o MESMO mecanismo do presente:
  // paths crus; icon(IconMapPin) saía vazio no iOS). Título/sub centralizados + chip de estado.
  // Ações: lr:share · lr:decline (quem recebeu) · lr:cancel (quem pediu), só com o pedido pendente.
  const L = require('../../services/locationRequest');
  const st = L.locReqState(m, ctx.myEmail, C.now);
  const T = L.locReqTexts(C.t, st, C.peerName, m.sender_name);
  const col = C.colors || {};
  const textColor = own ? C.ownText : (col.text || '#111111');
  const subColor = own ? C.ownMeta : (col.textSecondary || C.otherMeta || '#6b7280');
  const chipBg = own ? inkAlpha(C.ownText || '#FFFFFF', 0.14) : 'rgba(127,127,127,0.14)';
  const W = L.MAP_W; const H = L.MAP_H;
  const street = 'rgba(255,255,255,0.09)';
  const ave = 'rgba(255,255,255,0.13)';
  const block = 'rgba(255,255,255,0.05)';
  const done = st.status !== 'pending';
  const map = [vstack([], { w: W, h: H, r: 16, bg: L.MAP_BG })];
  L.MAP_BLOCKS.forEach(([x, y, w, h]) => map.push(vstack([], { pos: 'tl', m: [y, 0, 0, x], w, h, r: 4, bg: block })));
  L.MAP_STREETS_H.forEach((y) => map.push(vstack([], { pos: 'tl', m: [y, 0, 0, 0], w: W, h: 1.5, bg: street })));
  L.MAP_STREETS_V.forEach((x) => map.push(vstack([], { pos: 'tl', m: [0, 0, 0, x], w: 1.5, h: H, bg: street })));
  map.push(vstack([], { pos: 'tl', m: [L.MAP_AVE_H, 0, 0, 0], w: W, h: 7, bg: ave }));
  map.push(vstack([], { pos: 'tl', m: [0, 0, 0, L.MAP_AVE_V], w: 7, h: H, bg: ave }));
  map.push(vstack([iconPaths([{ d: L.MAP_DIAG, k: ave, w: 6 }], { s: 120, vb: 120 })], { pos: 'tl', m: [0, 0, 0, 0] }));
  map.push(vstack([], { pos: 'c', w: 92, h: 92, r: 46, bw: 1, bc: done ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.14)' }));
  map.push(vstack([], { pos: 'c', w: 60, h: 60, r: 30, bg: done ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.10)' }));
  map.push(vstack([], { pos: 'c', w: 30, h: 30, r: 15, bg: done ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.18)' }));
  map.push(vstack([iconPaths([{ d: L.PIN_OUTER, f: done ? '#9a9a9a' : '#ffffff' }, { d: L.PIN_HOLE, f: L.MAP_BG }], { s: 44 })], { pos: 'c', m: [0, 0, 18, 0] }));
  const kids = [
    zstack(map, { m: [0, 0, 10, 0], r: 16 }),
    text(T.title, { fs: 16, fw: 800, c: textColor, ml: 1, ta: 'c' }),
    text(T.sub, { fs: 12.5, fw: 600, c: subColor, ml: 2, ta: 'c', m: [3, 6, 0, 6] }),
    hstack([text(T.chip, { fs: 11.5, fw: 700, c: textColor })], { h: 22, r: 11, p: [0, 10, 0, 10], bg: chipBg, al: 'c', jc: 'c', m: [8, 0, 0, 0] }),
  ];
  if (L.locReqActionable(m, st)) {
    const pbg = own || C.isDark ? '#FFFFFF' : '#111111';
    const pink = own || C.isDark ? '#111111' : '#FFFFFF';
    kids.push(hstack([
      vstack([text(T.decline, { fs: 14, fw: 700, c: textColor })], { fl: 1, h: 36, r: 18, bw: 1.2, bc: textColor, al: 'c', jc: 'c', a: 'lr:decline' }),
      vstack([text(T.share, { fs: 14, fw: 700, c: pink })], { fl: 1, h: 36, r: 18, bg: pbg, al: 'c', jc: 'c', a: 'lr:share' }),
    ], { w: -1, g: 8, m: [12, 0, 0, 0] }));
  } else if (L.locReqCancelable(m, st)) {
    kids.push(vstack([text(T.cancel, { fs: 14, fw: 700, c: textColor })], { w: -1, h: 36, r: 18, bw: 1.2, bc: textColor, al: 'c', jc: 'c', m: [12, 0, 0, 0], a: 'lr:cancel' }));
  }
  row.bl = [vstack(kids, { al: 'c', p: [6, 6, 2, 6], w: W + 12 })];
  row.cw = W + 12; row.pad = PAD; row.mp = 'below';
}

// ─── [assistir-junto 2026-10-20] convite "Assistir/Ouvir junto" (espelho de components/watch/WatchInviteCard) ───
// Ação: watch:open → sala (app/watch-room). Ao vivo/encerrada vem do estado da sessão (services/watchTogether);
// mudança de sessão/viewers → cards.bump(). Sem relógio correndo aqui (o JS mostra o tempo).
function _watchOn() { try { return require('../../services/watchTogether').watchEnabled(); } catch { return false; } }
let _watchBumpFn = null;
let _watchBumpOff = null;
function _watchHookBump(C) {
  if (C && typeof C.bump === 'function') _watchBumpFn = C.bump;
  if (_watchBumpOff) return;
  try {
    let last = '';
    _watchBumpOff = require('../../services/watchTogether').onAnySession((cid, s) => {
      const sig = s ? [s.sid, s.status, s.qi, (s.item && s.item.id) || '', (s.viewers || []).length].join('|') : 'null';
      if (sig === last) return;
      last = sig;
      try { _watchBumpFn && _watchBumpFn(); } catch {}
    });
  } catch {}
}
function buildWatch(m, row, ctx, C, own) {
  const WT = require('../../services/watchTogether');
  const W = require('../watch/WatchIcons');
  const j = WT.parseWatchContent(m.content);
  if (!j) return;
  _watchHookBump(C);
  const tf = (k, fb, vars) => WT.tr(C.t, k, fb, vars);
  const s = WT.getSession(m.conversation_id);
  const same = s && s.sid === j.sid;
  const live = same ? WT.isLive(s) : (j.status === 'live' && !s);
  const music = j.mode === 'music';
  const cur = same && s.item ? s.item : { title: j.title, thumb: j.thumb };
  const P = _palette(own, C); const col = P.col;
  const ink = own ? C.ownText : (col.text || '#111111');
  const sub = own ? C.ownMeta : (col.textSecondary || C.otherMeta || '#6b7280');
  const w = 268;
  const me = String(ctx.myEmail || '').toLowerCase();
  const who = String(j.host || '').toLowerCase() === me ? tf('watch.you', 'Você') : (j.host_name || '');
  const verb = music ? tf('watch.card.startedListening', 'começou a ouvir') : tf('watch.card.startedWatching', 'começou a assistir');
  const liveTag = live ? hstack([vstack([], { w: 7, h: 7, r: 4, bg: '#ff453a' }), text(tf('watch.card.live', 'AO VIVO'), { fs: 11.5, fw: 700, c: '#FFFFFF' })],
    { g: 6, al: 'c', bg: 'rgba(0,0,0,0.55)', r: 11, p: [3, 9, 3, 9] }) : null;
  let cover;
  if (music) {
    // [separação 20/10] música: capa quadrada + equalizador (vídeo: pôster + AO VIVO)
    const eq = live ? hstack([7, 13, 9, 15].map((hh) => vstack([], { w: 3, h: hh, r: 1, bg: '#FFFFFF' })), { g: 2, al: 'c' }) : null;
    cover = hstack([
      cur.thumb ? image(cur.thumb, { w: 72, h: 72, r: 10, fit: 'cover' }) : vstack([icon(W.IconHeadphones, { s: 30, c: '#FFFFFF' })], { w: 72, h: 72, r: 10, bg: '#3a3a3c', al: 'c', jc: 'c' }),
      vstack([
        text(cur.title || '', { fs: 15, fw: 700, c: '#FFFFFF', ml: 2 }),
        cur.artist || cur.author ? text(cur.artist || cur.author, { fs: 12, c: 'rgba(255,255,255,0.8)', ml: 1 }) : null,
        live ? text(tf('watch.card.live', 'AO VIVO'), { fs: 10.5, fw: 800, c: '#ff453a', m: [4, 0, 0, 0] }) : null,
      ], { fl: 1 }),
      eq,
    ], { w: -1, g: 12, al: 'c', p: [12, 12, 12, 12], bg: '#0b0b0c', a: 'watch:open' });
  } else {
    const base = cur.thumb ? image(cur.thumb, { w: -1, h: 128, fit: 'cover', bg: '#1c1c1e' }) : vstack([icon(W.IconTogether, { s: 40, c: 'rgba(255,255,255,0.7)' })], { w: -1, h: 128, bg: '#1c1c1e', al: 'c', jc: 'c' });
    cover = zstack([base, liveTag ? vstack([liveTag], { pos: 'tl', m: [10, 10, 0, 0] }) : null], { w: -1, a: 'watch:open' });
  }
  const viewers = same ? WT.viewersOf(s) : [];
  const others = viewers.filter((v) => String(v.e).toLowerCase() !== String(j.host || '').toLowerCase());
  const status = !live ? tf('watch.ended', 'Sessão encerrada')
    : (others.length === 1 ? tf('watch.card.joined1', '{name} entrou', { name: String(others[0].e).toLowerCase() === me ? tf('watch.you', 'Você') : others[0].n })
      : (others.length > 1 ? tf('watch.card.joinedN', '{n} entraram', { n: others.length }) : ''));
  const joinBg = own || C.isDark ? '#FFFFFF' : '#111111';
  const joinInk = own || C.isDark ? '#111111' : '#FFFFFF';
  const body = vstack([
    text(who + ' ' + verb + ' ' + (j.title || ''), { fs: 14.5, c: ink, lh: 19 }),
    text(WT.sourceLabel(C.t, j) + (j.dur ? ' · ' + WT.fmtTime(j.dur) : ''), { fs: 12, c: sub, m: [3, 0, 0, 0] }),
    hstack([
      text(status, { fs: 12, c: sub, fl: 1 }),
      live ? hstack([text(music ? tf('watch.card.listen', 'Ouvir junto') : tf('watch.card.join', 'Entrar'), { fs: 14, fw: 700, c: joinInk })],
        { bg: joinBg, r: 16, p: [8, 16, 8, 16], a: 'watch:open' }) : null,
    ], { w: -1, al: 'c', g: 8, m: [10, 0, 0, 0] }),
  ], { w: -1, p: [10, 12, 12, 12], a: live ? 'watch:open' : undefined });
  row.bl = [vstack([cover, body], { w, r: 18, m: [1, 0, 1, 0] })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
}

export function buildFallbackCard(item, row, ctx, reason) {
  const C = ctx && ctx.cards;
  const isAlbum = item && item._type === 'album';
  const m = isAlbum ? ((item._items || [])[0] || item) : item;
  const type = (m && m.type) || 'text';
  let Ic = IconMessageCircle; let title = _tr(C, 'chatConv.nlMessage', 'Mensagem');
  if (type === 'gif') { Ic = IconFilm; title = _tr(C, 'chat.gif', 'GIF'); } // [2026-10-16 gif] nunca "Foto"
  else if (type === 'image') { Ic = IconImage; title = _tr(C, 'chat.photo', 'Foto'); }
  else if (type === 'video' || type === 'short_video' || type === 'video_note' || type === 'video_message') { Ic = IconVideo; title = _tr(C, 'chat.video', 'Vídeo'); }
  else if (type === 'audio' || type === 'voice' || type === 'voicemail') { Ic = IconMic; title = _tr(C, 'chat.audio', 'Áudio'); }
  else if (type === 'file' || type === 'document') { Ic = IconFile; title = String(m.file_name || '').trim() || _tr(C, 'chat.file', 'Arquivo'); }
  else if (type === 'sticker' || type === 'lottie_sticker') { Ic = IconSmile; title = _tr(C, 'chat.sticker', 'Figurinha'); }
  if (isAlbum && (item._items || []).length > 1) title = `${title} · ${(item._items || []).length}`;
  let sub = '';
  const raw = typeof (isAlbum ? item.content : m.content) === 'string' ? String(isAlbum ? item.content : m.content) : '';
  const rc = raw.trim();
  const hidden = !!(item._blurred || (item._filtered && item._hidden) || _isViewOnce(m));
  if (!hidden && rc && !/^[{[]/.test(rc) && !/^(https?:\/\/|\/?data\/)/i.test(rc) && !rc.startsWith('🔒')) {
    sub = rc.split('\n')[0].slice(0, 90);
  }
  if (!sub) sub = _tr(C, 'chatConv.nlTapToOpen', 'Toque para abrir');
  const own = _own(item, ctx || {});
  const col = (C && C.colors) || {};
  const ink = own ? ((C && C.ownText) || '#F6F6F3') : (col.text || '#111111');
  const subtle = own ? ((C && C.ownMeta) || 'rgba(246,246,243,0.55)') : (col.textSecondary || '#666666');
  const dark = !!(C && C.isDark);
  const w = _clampW(200, 280, 36 + 10 + Math.max(_estW(title, 14, true), Math.min(_estW(sub, 12), 190)) + 10 + 14 + 8);
  row.bl = [hstack([
    // [2026-10-17 polish-chat] círculo na tinta da bolha (antes #111 8% = invisível na enviada preta).
    vstack([icon(Ic, { s: 18, c: ink })], { w: 36, h: 36, r: 18, bg: inkAlpha(ink, dark && !own ? 0.12 : 0.14), al: 'c', jc: 'c' }),
    vstack([text(title, { fs: 14, fw: 600, c: ink, ml: 1 }), text(sub, { fs: 12, c: subtle, ml: 2, m: [1, 0, 0, 0] })], { fl: 1 }),
    icon(IconChevronRight, { s: 14, c: subtle }),
  ], { g: 10, al: 'c', p: [6, 2, 6, 0], w, a: 'jsrow' })];
  row.cw = w; row.pad = PAD; row.mp = 'below';
  row.fb = String(reason || '').slice(0, 24); // diagnóstico (ignorado pelo nativo)
  if (item._failed && own) row.fail = 1;
  return !!(row.bl[0]);
}

// [linkpreview 2026-10-18] Esqueleto com a altura do cartão (imagem + texto) enquanto a prévia não chega
// (patch WS do servidor ou busca) — a lista nativa já reserva o espaço, nada pula. Só nós JS (sem build).
function linkSkeleton(url, C, own) {
  const col = C.colors || {};
  const ink = own ? (C.ownText || '#FFFFFF') : (C.otherInk || col.text || '#111111');
  let cardBg = 'rgba(128,128,128,0.10)'; let blk = 'rgba(128,128,128,0.16)';
  try { cardBg = inkAlpha(ink, 0.08); blk = inkAlpha(ink, 0.12); } catch {}
  return vstack([
    vstack([], { w: -1, h: LP_SKELETON.imageH, bg: blk }),
    vstack([
      vstack([], { w: 90, h: 10, r: 5, bg: blk, m: [3, 0, 7, 0] }),
      vstack([], { w: 200, h: 12, r: 6, bg: blk, m: [0, 0, 9, 0] }),
      vstack([], { w: 230, h: 10, r: 5, bg: blk, m: [0, 0, 7, 0] }),
      vstack([], { w: 160, h: 10, r: 5, bg: blk }),
    ], { p: [8, 12, 8, 12], w: -1, h: LP_SKELETON.textH }),
  ], { id: 'lp', w: LP_SKELETON.width, r: _tgB() ? 6 : 10, m: [6, 0, 0, 0], bg: cardBg, a: 'lp:' + url });
}

function linkCard(url, C, own, item) {
  // [linkpreview 2026-10-18] 1º a prévia gravada pelo servidor na mensagem (sem rede); depois cache/busca.
  const known = previewForMessage(item, url);
  let pv = null;
  if (known) {
    if (known.kind !== 'ok') return null;
    pv = known.data;
    try { if (C.lp && C.lp.get(url) === undefined) C.lp.set(url, pv); } catch {}
  } else {
    if (C.lp && C.lp.skip && C.lp.skip(url)) return null;
    pv = _lpFor(url, C, isFreshMessage(item) ? 4000 : 300);
    if (!pv) {
      let pending = false;
      try { pending = !!(C.lp && typeof C.lp.get === 'function' && C.lp.get(url) === undefined); } catch {}
      return pending ? linkSkeleton(url, C, own) : null;
    }
  }
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
  // [2026-10-17 conv-wa-polish] cartão EMBUTIDO na bolha (WhatsApp): fundo =
  // tinta da bolha a 8%, sem hairline, textos na tinta da bolha. Antes: surface
  // (branco no claro / #0b0b0b no escuro) → cartão branco colado na bolha preta.
  // Sem imagem = só texto (sai o bloco de 80px com a inicial). Domínio em caixa
  // normal 12/500, título 14/600, descrição 13 (= LinkPreview JS).
  const ink = own ? (C.ownText || '#FFFFFF') : (C.otherInk || col.text || '#111111');
  const sub = own ? (C.ownMeta || 'rgba(255,255,255,0.62)') : (C.otherMeta || col.textSecondary || '#666666');
  let cardBg = 'rgba(128,128,128,0.10)';
  try { cardBg = inkAlpha(ink, 0.08); } catch {}
  void letter; void fbBg;
  const kids = [
    pv.image ? (isYt
      ? zstack([
        image(pv.image, { w: -1, h: 140, bg: '#00000010', fit: 'cover' }),
        vstack([icon(IconPlay, { s: 22, c: '#FFFFFF' })], { pos: 'c', w: 52, h: 52, r: 26, bg: 'rgba(0,0,0,0.62)', al: 'c', jc: 'c' }),
      ], { w: -1, h: 140 })
      : image(pv.image, { w: -1, h: 140, bg: '#00000010', fit: 'cover' }))
      : null,
  ].filter(Boolean);
  const tc = [];
  if (domain) {
    tc.push(hstack([
      fav ? image(fav, { w: 14, h: 14, r: 3 }) : icon(IconGlobe, { s: 12, c: sub }),
      text(domain, { fs: 12, fw: _tgB() ? 600 : 500, c: sub, fl: 1, ml: 1 }),
    ], { g: 6, m: [0, 0, 3, 0], al: 'c', w: -1 }));
  }
  if (pv.title) tc.push(text(String(pv.title), { fs: 14, fw: 600, m: [0, 0, 2, 0], lh: 19, ml: 2, c: ink }));
  if (pv.description) tc.push(text(String(pv.description), { fs: 13, lh: 17, ml: 2, c: sub }));
  if (!tc.length && !kids.length) return null;
  kids.push(vstack(tc, { p: [8, 12, 8, 12], w: -1 }));
  return vstack(kids, { id: 'lp', w: 280, r: _tgB() ? 6 : 10, m: [6, 0, 0, 0], bg: cardBg, a: 'lp:' + url });
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
        const card = linkCard(mm[0], C, own, item);
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
      case 'clink': buildCallLinkCard(item, row, C, own); break; // [call-link 2026-10-19]
      case 'giftext': buildGifText(item, row); break;
      case 'vn': buildVideoNote(item, row, ctx, C); break;
      case 'gift': buildGift(item, row, ctx, C, own); break;
      case 'status_reply': buildStatusReply(item, row, ctx, C, own); break;
      case 'vo': buildViewOnce(item, row, ctx, C, own); break;
      case 'voicemail': buildVoicemail(item, row, C, own); break;
      case 'lottie_sticker': buildLottie(item, row, C); break;
      case 'game': buildGame(item, row, ctx, C, own); break; // [jogos 2026-10-18]
      case 'location_request': buildLocReq(item, row, ctx, C, own); break; // [loc-pedido 2026-10-19]
      case 'watch_session': buildWatch(item, row, ctx, C, own); break; // [assistir-junto 2026-10-20]
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
        if (L.lat == null || L.lng == null) return; // [2026-10-21 polish-conv] sem coordenadas: não abre o mapa em 0,0
        const _lj = _json(m.content) || {};
        D.setMapModalData({ lat: L.lat, lng: L.lng, label: L.addr, isLive: L.isLive, liveUntil: L.until, isUnlimited: L.unlimited, messageId: m.id, conversationId: D.conversationId,
          senderEmail: m.sender_email || '', senderName: m.sender_name || '', isOwn: String(m.sender_email || '').toLowerCase() === String(D.currentEmail || '').toLowerCase(), updatedAt: _lj.updated_at || m.created_at || null });
        return;
      }
      case 'jloc': {
        const j = _json(m.content) || {};
        D.setMapModalData({ lat: j.latitude, lng: j.longitude, label: String(j.label || j.address || ''), isLive: !!(j.live || m.live), liveUntil: j.live_until || m.live_until || null, messageId: m.id, conversationId: D.conversationId,
          senderEmail: m.sender_email || '', senderName: m.sender_name || '', isOwn: String(m.sender_email || '').toLowerCase() === String(D.currentEmail || '').toLowerCase(), updatedAt: j.updated_at || m.created_at || null });
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
            const c = typeof x.content === 'string' ? JSON.parse(x.content || '{}') : { ...(x.content || {}) };
            c.live_until = Math.floor(Date.now() / 1000) - 1; c.live = false; c.is_unlimited = false;
            return { ...x, content: JSON.stringify(c), is_unlimited: false };
          } catch { return x; }
        }));
        return;
      }
      case 'ct_open': { // [2026-10-17 share-contact] toque no cartão → folha de detalhes
        try { if (require('./ContactCardSheet').openContactCard(m.contact && typeof m.contact === 'object' ? m.contact : m.content)) return; } catch {}
        return;
      }
      case 'ct_msg': case 'ct_inv': case 'ct_save': case 'ct_call': {
        // [2026-10-21 contato-msg] ações do cartão = contactShare (mesmas do cartão JS e da folha).
        const ct = _contact(m, { t });
        const cs = require('./contactShare');
        const cto = _ctObj(ct);
        const chk = _ctMap.get(String(ct.email || '') + '|' + String(ct.phone || ''));
        const target = chk && !chk.loading && chk.has ? (chk.email || ct.email) : '';
        if (kind === 'ct_call') {
          if (_pstnEnabled()) { if (ct.phone) D.Linking.openURL(`tel:${ct.phone.replace(/[^+\d]/g, '')}`).catch?.(() => {}); return; }
          cs.callContact(cto, D.router, t, target, { myEmail: D.currentEmail });
          return;
        }
        if (kind === 'ct_msg') { cs.openChatWith(cto, D.router, target, { t, myEmail: D.currentEmail }); return; }
        if (kind === 'ct_inv') { cs.inviteContact(cto, t); return; }
        cs.addOrOpenContact(cto, t);
        return;
      }
      case 'watch': { // [assistir-junto 2026-10-20] cartão do convite → sala
        try { D.router.push({ pathname: '/watch-room', params: { cid: String(m.conversation_id || D.conversationId || ''), name: '' } }); } catch {}
        return;
      }
      case 'poll': { _vote(m, Number(arg), D); return; }
      case 'poll_votes': { // [2026-10-16 poll-wa] + [wave13e] folha com quem votou
        const _pv = _poll(m);
        if (require('./PollVotesSheet').openPollVotes(_pv, m.id)) return;
        showPollVotes(_pv, tt, (a, b) => D.safeAlert(a, b)); return;
      }
      case 'rsvp': {
        (async () => {
          const r = await api.chatMeetupRsvp(m.id, arg);
          if (r && r.success) {
            D.setMessages(prev => D.mapKeep(prev, x => {
              if (x.id !== m.id) return x;
              let content = x.content;
              const dd = r.data || {};
              try { const d = JSON.parse(x.content); if (dd.rsvp) d.rsvp = dd.rsvp; if (dd.rsvps) d.rsvps = dd.rsvps; content = JSON.stringify(d); } catch {}
              return { ...x, content, meetup: { ...(x.meetup || {}), ...(r.data || {}) } };
            }));
          }
        })().catch(() => {});
        return;
      }
      case 'mt_info': { // [encontro3 2026-10-20] detalhes: quem vai / talvez / não vai
        try { globalThis.__chatyy_meetup_details_open && globalThis.__chatyy_meetup_details_open(m); } catch {}
        return;
      }
      case 'mt_edit': { // [encontro2 2026-10-20] autor abre a folha de edição
        try { globalThis.__chatyy_meetup_edit_open && globalThis.__chatyy_meetup_edit_open(m); } catch {}
        return;
      }
      case 'mt_map': { // [encontro 2026-10-19] mapa/endereço do cartão do encontro
        const mt = _json(m.content) || m.meetup || {};
        const ML = _meetupLoc(mt.location);
        if (ML.lat != null && ML.lng != null) { D.setMapModalData({ lat: ML.lat, lng: ML.lng, label: ML.text || String(mt.title || '') }); return; }
        if (ML.text) {
          const q = encodeURIComponent(ML.text);
          D.Linking.openURL(Platform.OS === 'ios' ? `http://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`).catch?.(() => {});
        }
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
      case 'clink': { // [call-link 2026-10-19] cartão do link de chamada → lobby
        if (arg && /^[a-z0-9-]{6,80}$/i.test(arg)) D.router.push(require('../calls/callLinkUtil').callLinkRoute(arg));
        return;
      }
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
      case 'gift_thank': { if (typeof D.thankGift === 'function') D.thankGift(m); return; } // [gift-premium 2026-10-16]
      case 'game': { // [jogos 2026-10-18] · [2026-10-19 inline] lance no próprio cartão (mv/l/q) não sai do chat
        try { if (require('../../services/gamesInline').runInlineAction(m, arg, t)) return; } catch {}
        if (typeof D.gameAction === 'function') D.gameAction(m, arg || 'open'); return;
      }
      case 'lr': { if (typeof D.locReqAction === 'function') D.locReqAction(m, arg); return; } // [loc-pedido 2026-10-19] lr:share|decline
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
