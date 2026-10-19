// services/infoCache.js — [2026-10-19 info-cache] "Dados do contato / do grupo"
// e perfil abrindo NA HORA, como WhatsApp/Telegram.
//
// Founder: "as fotos de perfil das outras pessoas e o módulo que mostra os dados
// das outras pessoas deveria salvar cache para sempre abrir mais rápido".
//
// O que guarda (por CONTA — services/cache.js escopa a chave pela conta ativa;
// logout apaga tudo; troca de conta = outro namespace):
//   contato  ['ic1','u',<email>]  nome, recado/bio, telefone, @usuário, versão da
//                                 foto, capa, grupos em comum (≤30)
//   conversa ['ic1','c',<id>]     1ª página de membros (≤80) + total, faixa de
//                                 mídia/arquivos/links, contagens
// + o payload do profile_get vai também para a chave do Perfil (/u/<email>,
//   services/screenData.profileCacheKey) → "Ver perfil" abre sem esqueleto.
//
// Ciclo: a tela pinta da cópia (síncrono) e revalida em 2º plano; a conversa
// pré-busca (debounce) ao abrir → tocar no cabeçalho já acha tudo salvo.
// Teto: 500 entradas (LRU por conta, índice próprio) dentro do orçamento global
// do services/cache.js (30 MB); cópia vale até 60 dias.
// Privacidade: bloqueio / foto oculta → purgeContact() apaga a entrada, o perfil
// salvo e as fotos no disco (avatarCache.purgeAvatarForEmail).
// Telemetria: taxa de acerto das aberturas → nativeTelemetry.nativeBeacon('info_cache').
// Kill switch (OTA): globalThis.__chatyy_info_cache = false → não lê/grava/pré-busca.
import { Platform, AppState } from 'react-native';
import { peekCached, putCached, dropCached } from '../hooks/useCachedAction';
import { hasCacheUser, cacheUserScope } from './cache';

const MAX_ENTRIES = 500;
const MAX_AGE = 60 * 24 * 3600 * 1000;
const PREFETCH_DEBOUNCE_MS = 1200;
const PREFETCH_FRESH_MS = 10 * 60 * 1000;
const IDX_KEY = ['ic1', 'idx'];

export function infoCacheEnabled() {
  try { if (globalThis.__chatyy_info_cache === false) return false; } catch {}
  return true;
}

function _lc(e) { return String(e || '').trim().toLowerCase(); }
function _uKey(email) { return ['ic1', 'u', _lc(email)]; }
function _cKey(id) { return ['ic1', 'c', String(id == null ? '' : id)]; }
function _api() { try { return require('./api'); } catch { return null; } }

// ── LRU por conta (500 entradas) ─────────────────────────────────────────────
let _idx = null; // Map 'u:<email>' | 'c:<id>' → lastUse
let _idxScope = '';
let _idxTimer = null;
function _idxLoad() {
  const sc = cacheUserScope();
  if (_idx && _idxScope === sc) return _idx;
  _idxScope = sc;
  _idx = new Map();
  try {
    const arr = peekCached(IDX_KEY, 0);
    if (Array.isArray(arr)) for (const it of arr) if (Array.isArray(it) && typeof it[0] === 'string') _idx.set(it[0], Number(it[1]) || 0);
  } catch {}
  return _idx;
}
function _idxSave() {
  if (_idxTimer) return;
  _idxTimer = setTimeout(() => {
    _idxTimer = null;
    if (!_idx || _idxScope !== cacheUserScope()) return;
    try { putCached(IDX_KEY, Array.from(_idx.entries())); } catch {}
  }, 1500);
}
function _idxTouch(id) {
  const m = _idxLoad();
  m.delete(id);
  m.set(id, Date.now());
  while (m.size > MAX_ENTRIES) {
    const old = m.keys().next().value;
    m.delete(old);
    try { dropCached(old.startsWith('u:') ? _uKey(old.slice(2)) : _cKey(old.slice(2))); } catch {}
  }
  _idxSave();
}
function _idxDrop(id) {
  const m = _idxLoad();
  if (m.delete(id)) _idxSave();
}

function _get(key, id) {
  if (!infoCacheEnabled() || !hasCacheUser()) return null;
  let v = null;
  try { v = peekCached(key, MAX_AGE); } catch { v = null; }
  if (v && typeof v === 'object') {
    // leitura conta como uso (só memória; vai junto da próxima gravação do índice)
    try { const m = _idxLoad(); if (m.has(id)) { m.delete(id); m.set(id, Date.now()); } } catch {}
    return v;
  }
  return null;
}
function _put(key, id, patch) {
  if (!infoCacheEnabled() || !hasCacheUser() || !patch || typeof patch !== 'object') return null;
  let prev = null;
  try { prev = peekCached(key, MAX_AGE); } catch { prev = null; }
  const next = { ...(prev && typeof prev === 'object' ? prev : {}), ...patch, ts: Date.now() };
  // só grava se mudou algo além do ts (evita escrita a cada revalidação igual)
  try {
    if (prev && typeof prev === 'object') {
      const a = { ...prev }; delete a.ts;
      const b = { ...next }; delete b.ts;
      if (JSON.stringify(a) === JSON.stringify(b) && prev.ts && Date.now() - prev.ts < PREFETCH_FRESH_MS) { _idxTouch(id); return prev; }
    }
  } catch {}
  try { putCached(key, next); } catch {}
  _idxTouch(id);
  return next;
}

// ── Contato ──────────────────────────────────────────────────────────────────
function _slimGroups(list) {
  if (!Array.isArray(list)) return undefined;
  return list.filter((g) => g && g.id != null).slice(0, 30).map((g) => ({ id: g.id, name: String(g.name || '').slice(0, 120), type: g.type || 'group' }));
}
function _slimIdentity(ident) {
  if (!ident || typeof ident !== 'object') return undefined;
  const o = {};
  for (const k of ['email', 'username', 'name', 'bio', 'phone', 'website', 'cover_url', 'avatar_url', 'avatar_version', 'account_type', 'pronouns', 'proCategory', 'verified']) {
    if (ident[k] != null && ident[k] !== '') o[k] = typeof ident[k] === 'string' ? ident[k].slice(0, 600) : ident[k];
  }
  return o;
}

/** Última info salva do contato `email` (síncrono) — { identity, groups, ts } | null. */
export function getContactInfo(email) {
  const e = _lc(email);
  if (!e) return null;
  return _get(_uKey(e), 'u:' + e);
}

/** Mescla e grava. Aceita { identity, groups, blocked } (campos ausentes ficam). */
export function putContactInfo(email, patch) {
  const e = _lc(email);
  if (!e || !patch) return null;
  const p = {};
  if (patch.identity) p.identity = _slimIdentity(patch.identity);
  if (patch.groups) p.groups = _slimGroups(patch.groups);
  if (patch.counts && typeof patch.counts === 'object') p.counts = patch.counts;
  return _put(_uKey(e), 'u:' + e, p);
}

/** Resposta crua do profile_get → contato + cópia do Perfil (/u/<email>). */
export function ingestProfile(email, data) {
  if (!data || typeof data !== 'object' || !infoCacheEnabled()) return;
  const e = _lc(email || data?.identity?.email);
  if (!e) return;
  const groups = (data.common_chats || []).filter((c) => c && c.type === 'group');
  const counts = {};
  try {
    const so = data.social || {};
    for (const k of ['followers', 'following', 'posts', 'posts_count', 'followers_count', 'following_count']) if (so[k] != null) counts[k] = so[k];
    if (Array.isArray(data.posts) && counts.posts == null) counts.posts = data.posts.length;
  } catch {}
  putContactInfo(e, { identity: data.identity, groups, counts });
  // Mesma chave que components/Profile.js lê (services/cache.js, por conta).
  try {
    const { profileCacheKey } = require('./screenData');
    putCached(profileCacheKey(e), data);
  } catch {}
  try {
    const v = data?.identity?.avatar_version;
    if (typeof v === 'number' && v > 0) _api()?.bustAvatarCache?.(e, v);
  } catch {}
}

// ── Conversa (grupo/direct) ──────────────────────────────────────────────────
function _slimMembers(list) {
  if (!Array.isArray(list)) return undefined;
  return list.filter((m) => m && m.email).slice(0, 80).map((m) => {
    const o = { email: String(m.email) };
    if (m.display_name) o.display_name = String(m.display_name).slice(0, 80);
    if (m.role) o.role = m.role;
    if (m.avatar_url) o.avatar_url = String(m.avatar_url).slice(0, 300);
    return o;
  });
}
function _slimMediaItems(list, n) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, n).map((it) => {
    if (!it || typeof it !== 'object') return it;
    const o = {};
    for (const k of ['id', 'type', 'msg_type', 'thumb_url', 'file_url', 'file_name', 'file_size', 'created_at', 'content', 'url', 'title', 'site_name', 'host']) {
      if (it[k] != null && it[k] !== '') o[k] = typeof it[k] === 'string' ? it[k].slice(0, 400) : it[k];
    }
    return o;
  });
}

/** Última info salva da conversa (síncrono) — { members, membersTotal, membersMore, media, ts } | null. */
export function getConvInfo(convId) {
  if (convId == null || convId === '') return null;
  return _get(_cKey(convId), 'c:' + String(convId));
}

/**
 * Mescla e grava. patch: { members, membersTotal, membersMore, media: {media, files, links},
 * thumbs, muted }.
 */
export function putConvInfo(convId, patch) {
  if (convId == null || convId === '' || !patch) return null;
  const p = {};
  if (patch.members) p.members = _slimMembers(patch.members);
  if (patch.membersTotal != null) p.membersTotal = Number(patch.membersTotal) || 0;
  if (patch.membersMore != null) p.membersMore = !!patch.membersMore;
  if (patch.thumbs) p.thumbs = _slimMediaItems(patch.thumbs, 9);
  if (patch.media && typeof patch.media === 'object') {
    const prev = getConvInfo(convId)?.media || {};
    p.media = { ...prev };
    if (patch.media.media) p.media.media = _slimMediaItems(patch.media.media, 9);
    if (patch.media.files) p.media.files = _slimMediaItems(patch.media.files, 5);
    if (patch.media.links) p.media.links = _slimMediaItems(patch.media.links, 12);
  }
  if (patch.muted !== undefined) p.muted = patch.muted || null;
  return _put(_cKey(convId), 'c:' + String(convId), p);
}

// ── Privacidade ──────────────────────────────────────────────────────────────
/** Bloqueio / foto oculta: apaga info, perfil salvo e fotos do disco desta pessoa. */
export function purgeContact(email) {
  const e = _lc(email);
  if (!e) return;
  try { dropCached(_uKey(e)); } catch {}
  _idxDrop('u:' + e);
  try { const { profileCacheKey } = require('./screenData'); dropCached(profileCacheKey(e)); } catch {}
  try { require('../components/Profile').invalidateProfileCache?.(e); } catch {}
  try { require('./avatarCache').purgeAvatarForEmail(e); } catch {}
}

// ── Telemetria (taxa de acerto ao abrir) ─────────────────────────────────────
const _tm = { contact: [0, 0], group: [0, 0], profile: [0, 0] }; // [hits, total]
let _tmSince = 0;
let _tmHooked = false;
function _flushTelemetry(why) {
  let total = 0;
  for (const k of Object.keys(_tm)) total += _tm[k][1];
  if (!total) return;
  const parts = Object.keys(_tm).filter((k) => _tm[k][1] > 0).map((k) => `${k[0]}=${_tm[k][0]}/${_tm[k][1]}`);
  let hits = 0;
  for (const k of Object.keys(_tm)) hits += _tm[k][0];
  try {
    require('./nativeTelemetry').nativeBeacon('info_cache', 'opens', `${parts.join(' ')} rate=${Math.round((hits / total) * 100)} why=${why || ''}`);
  } catch {}
  for (const k of Object.keys(_tm)) _tm[k] = [0, 0];
  _tmSince = 0;
}
/** kind: 'contact' | 'group' | 'profile'; hit = pintou da cópia salva. */
export function noteInfoOpen(kind, hit) {
  if (Platform.OS === 'web' || !infoCacheEnabled()) return;
  const k = _tm[kind] ? kind : 'contact';
  _tm[k][1] += 1;
  if (hit) _tm[k][0] += 1;
  _tmSince += 1;
  if (!_tmHooked) {
    _tmHooked = true;
    try { AppState.addEventListener('change', (s) => { if (s === 'background') _flushTelemetry('bg'); }); } catch {}
  }
  if (_tmSince >= 10) _flushTelemetry('n');
}

// ── Pré-busca ao abrir a conversa (debounce) ─────────────────────────────────
const _lastPrefetch = new Map(); // key → ts
const _timers = new Map();
/**
 * Aquece "Dados do contato/grupo" em 2º plano. opts: { conversationId, type:
 * 'direct'|'group', peer }. onData(kind, value) opcional p/ a tela aplicar já.
 */
export function prefetchConversationInfo(opts, onData) {
  if (!opts || !infoCacheEnabled() || !hasCacheUser()) return () => {};
  const cid = opts.conversationId;
  const type = opts.type;
  const peer = _lc(opts.peer);
  if (cid == null || cid === '' || (type !== 'direct' && type !== 'group')) return () => {};
  const tk = `${type}:${cid}`;
  if (_timers.has(tk)) { clearTimeout(_timers.get(tk)); _timers.delete(tk); }
  let cancelled = false;
  const tm = setTimeout(async () => {
    _timers.delete(tk);
    if (cancelled) return;
    try { const ni = require('./networkInfo'); if (ni.isConnected && ni.isConnected() === false) return; } catch {}
    const api = _api();
    if (!api) return;
    const scope = cacheUserScope();
    const now = Date.now();
    // contato: profile_get (identidade + grupos em comum + perfil)
    if (type === 'direct' && peer) {
      const pk = 'u:' + peer;
      const c = getContactInfo(peer);
      if (!(c && c.ts && now - c.ts < PREFETCH_FRESH_MS) && !((_lastPrefetch.get(pk) || 0) > now - PREFETCH_FRESH_MS)) {
        _lastPrefetch.set(pk, now);
        try {
          const r = await api.profileGet?.(peer);
          if (!cancelled && r && r.success && r.data && cacheUserScope() === scope) {
            ingestProfile(peer, r.data);
            try { onData && onData('contact', getContactInfo(peer)); } catch {}
          }
        } catch {}
      }
      // privacidade mudou sem mudar a versão → revalida a foto (≤ 1×/6 h)
      try {
        const url = require('./avatar').buildAvatarUrl(peer);
        if (url) require('./avatarCache').revalidateAvatar(url);
      } catch {}
    }
    // conversa: membros (grupo) + faixa de mídia
    const ck = 'c:' + String(cid);
    const ci = getConvInfo(cid);
    if (ci && ci.ts && now - ci.ts < PREFETCH_FRESH_MS) return;
    if ((_lastPrefetch.get(ck) || 0) > now - PREFETCH_FRESH_MS) return;
    _lastPrefetch.set(ck, now);
    if (_lastPrefetch.size > 400) _lastPrefetch.delete(_lastPrefetch.keys().next().value);
    if (type === 'group' && api.chatMembersPage) {
      try {
        const r = await api.chatMembersPage(cid, { limit: 80, offset: 0, q: '' });
        const d = (r && r.success && (r.data?.conversation || r.data)) || null;
        if (!cancelled && d && Array.isArray(d.members) && cacheUserScope() === scope) {
          const total = d.members_total != null ? Number(d.members_total) : d.members.length;
          putConvInfo(cid, { members: d.members, membersTotal: total, membersMore: d.members_next_offset != null });
          try { onData && onData('members', getConvInfo(cid)); } catch {}
        }
      } catch {}
    }
    if (cancelled) return;
    try {
      let r = api.chatSharedItems ? await api.chatSharedItems(cid, 'image', '', 9) : null;
      if (!(r && r.success) && api.chatMediaGallery) r = await api.chatMediaGallery(cid, 'image', 9);
      if (!cancelled && r && r.success && cacheUserScope() === scope) {
        const items = (r.data?.items || []).filter((it) => it && it.file_url).slice(0, 9);
        putConvInfo(cid, { media: { media: items }, thumbs: items.slice(0, 6) });
        try { onData && onData('media', getConvInfo(cid)); } catch {}
      }
    } catch {}
  }, PREFETCH_DEBOUNCE_MS);
  _timers.set(tk, tm);
  return () => { cancelled = true; const t = _timers.get(tk); if (t === tm) { clearTimeout(tm); _timers.delete(tk); } };
}
