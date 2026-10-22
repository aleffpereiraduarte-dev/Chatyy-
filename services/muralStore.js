/**
 * Store do "Perfil com Mural" — [mural 2026-10-20]
 *
 * Uma cópia por post (id) compartilhada por PostViewer, TextPostView, folha de
 * comentários e quem mais assinar (grade/lista do perfil podem usar usePost).
 *   • curtir/salvar OTIMISTA, em série por post (toque rápido não embaralha o
 *     toggle do servidor) e rollback se falhar;
 *   • comentários com respostas (1 nível), curtir comentário, apagar — otimista
 *     com rollback;
 *   • ao vivo [mural-rt 2026-10-22]: post_rt_sub (assinatura por post c/ permissão) + eventos WS
 *     post_like / post_comment / post_update no canal por-usuário; polling leve se o WS cair; refetch ao focar.
 *
 * Contrato do servidor: /root/mural-2026-10-20/API.md (post_get, post_like,
 * post_view, post_comments, post_comment_create, post_comment_like,
 * post_comment_delete, post_edit, post_delete; WS canal feed_post_<id>). Toda
 * chamada cai na ação antiga do feed (feed_get_post, feed_like, feed_comments,
 * feed_comment, feed_comment_like_toggle, feed_delete_comment…) quando o
 * servidor responde "Unknown action" — funciona com servidor velho.
 */
import { useSyncExternalStore, useCallback } from 'react';

function _api() { return require('./api'); }

const _posts = new Map(); // id -> post normalizado
const _subs = new Map(); // id -> Set(fn)
const _anySubs = new Set();
const _likeOps = new Map(); // id -> { want, inflight }
const _unknownActions = new Set();

// ─── Normalização ───────────────────────────────────────────────────────────
function _num(...vals) {
  for (const v of vals) { if (v != null && v !== '' && !Number.isNaN(Number(v)) && typeof v !== 'object') return Number(v); }
  return 0;
}
function _parseMedia(raw) {
  let urls = raw.media ?? raw.media_urls ?? raw.images ?? null;
  if (typeof urls === 'string') { try { urls = JSON.parse(urls); } catch { urls = urls ? [urls] : []; } }
  if (!Array.isArray(urls)) urls = [];
  const out = [];
  const thumbs = Array.isArray(raw.thumbnails) ? raw.thumbnails : [];
  urls.forEach((u, i) => {
    if (!u) return;
    if (typeof u === 'object') {
      const url = u.url || u.uri || u.src || u.cdn_url || '';
      if (!url) return;
      // [muralperf 2026-10-21] t320 (grade) / display ≤1280 (cartão, placeholder do visualizador) vindos do servidor
      out.push({ url, type: (u.type || u.media_type) === 'video' ? 'video' : 'image', thumb: u.thumb || u.thumbnail || u.poster || '', t320: u.t320 || '', grid: u.grid || '', display: u.display || '', w: u.w || u.width || 0, h: u.h || u.height || 0, blurhash: u.blurhash || null });
      return;
    }
    const isVid = /\.(mp4|mov|m4v|webm)(\?|$)/i.test(String(u)) || (i === 0 && raw.media_type === 'video' && urls.length === 1);
    out.push({ url: String(u), type: isVid ? 'video' : 'image', thumb: thumbs[i] || (i === 0 ? (raw.thumbnail_url || raw.thumb_url || '') : ''), w: 0, h: 0 });
  });
  if (!out.length && raw.media_url) out.push({ url: raw.media_url, type: raw.media_type === 'video' ? 'video' : 'image', thumb: raw.thumbnail_url || '', w: 0, h: 0 });
  return out;
}
function _audience(a) {
  const s = String(a || '').toLowerCase();
  if (s === 'contacts' || s === 'followers' || s === 'close_friends') return 'contacts';
  if (s === 'private' || s === 'only_me' || s === 'me' || s === 'self') return 'private';
  return 'public';
}
function _people(list) {
  if (!Array.isArray(list)) return [];
  return list.map((p) => (typeof p === 'string' ? { email: p, name: '' } : { email: p.email || p.user_email || '', name: p.name || p.display_name || '', username: p.username || '', avatar: p.avatar_url || p.avatar || '' })).filter((p) => p.email || p.name);
}

/** Objeto Post do contrato (API.md) — aceita também o formato antigo do feed_list. */
export function normalizePost(raw, prev) {
  if (!raw || typeof raw !== 'object') return prev || null;
  const id = Number(raw.id ?? raw.post_id);
  if (!id) return prev || null;
  const p = prev ? { ...prev } : {};
  p.id = id;
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k) && raw[k] != null;
  const au = raw.author && typeof raw.author === 'object' ? raw.author : {};
  p.author_email = String(au.email || raw.author_email || raw.email || p.author_email || '');
  p.author_name = au.name || raw.author_name || raw.name || p.author_name || '';
  p.author_username = au.username || raw.author_username || raw.username || p.author_username || '';
  p.author_avatar = au.avatar_url || au.avatar || raw.author_avatar || raw.avatar_url || p.author_avatar || '';
  if (has('text') || has('caption') || has('content')) p.caption = String(raw.text ?? raw.caption ?? raw.content ?? '');
  else if (p.caption == null) p.caption = '';
  const media = (has('media') || has('media_urls') || has('images') || has('media_url')) ? _parseMedia(raw) : null;
  if (media) p.media = media; else if (!p.media) p.media = [];
  if (has('like_count') || has('likes_count') || has('likes')) p.likes = _num(raw.like_count, raw.likes_count, raw.likes);
  else if (p.likes == null) p.likes = 0;
  if (has('comment_count') || has('comments_count') || (has('comments') && typeof raw.comments !== 'object')) p.comments = _num(raw.comment_count, raw.comments_count, raw.comments);
  else if (p.comments == null) p.comments = 0;
  if (has('view_count') || has('views_count') || has('views')) p.views = _num(raw.view_count, raw.views_count, raw.views);
  else if (p.views == null) p.views = 0;
  if (has('share_count') || has('shares_count')) p.shares = _num(raw.share_count, raw.shares_count);
  else if (p.shares == null) p.shares = 0;
  if (has('liked_by_me') || has('user_liked') || has('liked')) p.liked = !!(raw.liked_by_me ?? raw.user_liked ?? raw.liked);
  else if (p.liked == null) p.liked = false;
  if (has('user_bookmarked') || has('saved') || has('bookmarked') || has('saved_by_me')) p.saved = !!(raw.saved_by_me ?? raw.user_bookmarked ?? raw.saved ?? raw.bookmarked);
  else if (p.saved == null) p.saved = false;
  if (has('audience')) p.audience = _audience(raw.audience); else if (!p.audience) p.audience = 'public';
  if (has('created_at')) p.created_at = raw.created_at; else if (!p.created_at) p.created_at = null;
  if (has('edited_at') || raw.edited_at === null) p.edited_at = raw.edited_at || null;
  const likers = raw.likers_preview ?? raw.top_likers ?? null;
  if (Array.isArray(likers)) p.likers = _people(likers); else if (!p.likers) p.likers = [];
  if (has('likes_text')) p.likes_text = String(raw.likes_text || '');
  const tc = raw.top_comment ?? raw.highlight_comment ?? raw.featured_comment ?? null;
  if (tc && typeof tc === 'object') p.top_comment = _normComment(tc);
  if (has('is_mine') || has('is_owner') || has('viewer_is_owner')) p.is_mine = !!(raw.is_mine ?? raw.is_owner ?? raw.viewer_is_owner);
  if (has('allow_comments')) p.allow_comments = !(raw.allow_comments === false || raw.allow_comments === 0 || raw.allow_comments === '0');
  else if (p.allow_comments == null) p.allow_comments = true;
  if (has('is_pinned')) p.is_pinned = !!raw.is_pinned;
  p.kind = p.media && p.media.length ? 'photo' : 'text';
  p._v = (prev?._v || 0) + 1;
  return p;
}

// ─── Store de posts ────────────────────────────────────────────────────────
function _emit(id) {
  const k = Number(id);
  const set = _subs.get(k);
  if (set) for (const fn of Array.from(set)) { try { fn(); } catch {} }
  const p = _posts.get(k);
  for (const fn of Array.from(_anySubs)) { try { fn(p); } catch {} }
}
export function getPost(id) { return _posts.get(Number(id)) || null; }
export function primePost(raw) {
  const id = Number(raw?.id ?? raw?.post_id);
  if (!id) return null;
  const n = normalizePost(raw, _posts.get(id));
  if (n) { _posts.set(id, n); _emit(id); }
  return n;
}
export function patchPost(id, patch) {
  const k = Number(id);
  const prev = _posts.get(k);
  if (!prev) return null;
  const next = { ...prev, ...patch, _v: (prev._v || 0) + 1 };
  _posts.set(k, next);
  _emit(k);
  return next;
}
export function subscribePost(id, fn) {
  const k = Number(id);
  if (!_subs.has(k)) _subs.set(k, new Set());
  _subs.get(k).add(fn);
  _ensureWs();
  return () => { const s = _subs.get(k); if (s) { s.delete(fn); if (!s.size) _subs.delete(k); } };
}
/** fn(post) a cada mudança de QUALQUER post (grade/lista atualizam contadores). */
export function onAnyPostChange(fn) { _anySubs.add(fn); _ensureWs(); return () => _anySubs.delete(fn); }

export function usePost(id) {
  const sub = useCallback((fn) => subscribePost(id, fn), [id]);
  const snap = useCallback(() => getPost(id), [id]);
  return useSyncExternalStore(sub, snap, snap);
}

const _UNKNOWN_RE = /unknown action|invalid action|a[cç][aã]o (desconhecida|inv[aá]lida)/i;
async function _call(action, params, fallbackAction, fallbackParams) {
  const api = _api();
  if (!_unknownActions.has(action)) {
    let r = null;
    try { r = await api.apiCall(action, params, 'POST'); } catch (e) { r = { success: false, error: e?.message || 'network' }; }
    const msg = String((r && (r.error || r.message)) || '');
    if (!(r && r.success === false && _UNKNOWN_RE.test(msg))) return r;
    _unknownActions.add(action);
  }
  if (!fallbackAction) return { success: false, error: 'unsupported' };
  try { return await api.apiCall(fallbackAction, fallbackParams || params, 'POST'); } catch (e) { return { success: false, error: e?.message || 'network' }; }
}
function _errMsg(r) { return String((r && (r.message || r.error)) || ''); }
const _NOT_FOUND_RE = /not found|n[aã]o encontrad|removid|deleted|404/i;

const _loading = new Map();
/** Busca o post (post_get → feed_get_post). Resolve o post normalizado ou null. */
export function loadPost(id) {
  const k = Number(id);
  if (!k) return Promise.resolve(null);
  if (_loading.has(k)) return _loading.get(k);
  const pr = (async () => {
    const r = await _call('post_get', { id: k }, 'feed_get_post', { id: k, post_id: k });
    if (r && r.success && r.data) {
      const raw = r.data.post || r.data;
      return primePost({ ...raw, id: raw.id || k });
    }
    if (r && r.success === false && _NOT_FOUND_RE.test(_errMsg(r))) markDeleted(k);
    return _posts.get(k) || null;
  })().finally(() => { _loading.delete(k); });
  _loading.set(k, pr);
  return pr;
}
export function markDeleted(id) {
  const k = Number(id);
  const prev = _posts.get(k);
  _posts.set(k, { ...(prev || { id: k, media: [], caption: '', likes: 0, comments: 0 }), id: k, deleted: true, _v: ((prev && prev._v) || 0) + 1 });
  _emit(k);
}

// ─── Curtir / salvar / ver ─────────────────────────────────────────────────
/** Curtir otimista. `force` = true/false fixa o estado (toque duplo só curte). */
export function toggleLike(id, force) {
  const k = Number(id);
  const p = _posts.get(k);
  if (!p) return;
  const want = typeof force === 'boolean' ? force : !p.liked;
  if (want === p.liked) return;
  const op = _likeOps.get(k);
  if (!op) _likeOps.set(k, { want, inflight: false, base: { liked: p.liked, likes: p.likes, likers: p.likers } });
  else op.want = want;
  patchPost(k, { liked: want, likes: Math.max(0, (p.likes || 0) + (want ? 1 : -1)) });
  try { require('./haptics').hapticEvent?.(want ? 'like' : 'tap'); } catch {}
  if (!_likeOps.get(k).inflight) _runLike(k);
}
async function _runLike(k) {
  const op = _likeOps.get(k);
  if (!op) return;
  op.inflight = true;
  try {
    for (let guard = 0; guard < 4; guard++) {
      const want = op.want;
      const r = await _call('post_like', { id: k, like: want ? 1 : 0 }, 'feed_like', { post_id: k });
      if (!r || r.success === false) {
        const b = op.base;
        patchPost(k, { liked: b.liked, likes: b.likes, likers: b.likers });
        try { require('../components/ui/Toast').showToast({ message: _tr('mural.err.like', 'Não foi possível curtir'), kind: 'error' }); } catch {}
        return;
      }
      const d = r.data || {};
      const liked = d.liked != null ? !!d.liked : want;
      const cnt = d.like_count != null ? Number(d.like_count) : (d.likes_count != null ? Number(d.likes_count) : null);
      const cur = _posts.get(k);
      op.base = { liked, likes: cnt != null ? cnt : (cur?.likes || 0), likers: Array.isArray(d.likers_preview) ? _people(d.likers_preview) : cur?.likers };
      if (op.want !== liked) continue; // mudou de ideia no meio (ou o toggle antigo inverteu) → manda o atual
      const patch = { liked };
      if (cnt != null) patch.likes = cnt;
      if (Array.isArray(d.likers_preview)) patch.likers = _people(d.likers_preview);
      if (d.likes_text != null) patch.likes_text = String(d.likes_text || '');
      patchPost(k, patch);
      return;
    }
  } finally {
    _likeOps.delete(k);
  }
}

export async function toggleSave(id) {
  const k = Number(id);
  const p = _posts.get(k);
  if (!p) return;
  const want = !p.saved;
  patchPost(k, { saved: want });
  try { require('./haptics').hapticEvent?.('tap'); } catch {}
  let r = null;
  try { r = await _api().feedBookmark(k); } catch { r = null; }
  if (!r || r.success === false) {
    patchPost(k, { saved: !want });
    try { require('../components/ui/Toast').showToast({ message: _tr('mural.err.generic', 'Algo deu errado. Tente de novo.'), kind: 'error' }); } catch {}
    return;
  }
  const d = r.data || {};
  const got = d.bookmarked ?? d.saved;
  if (got != null && !!got !== want) {
    // feed_bookmark é toggle: ficou do lado errado → manda de novo
    try { await _api().feedBookmark(k); } catch {}
  }
  try { require('../components/ui/Toast').showToast({ message: _tr(want ? 'mural.saved' : 'mural.unsaved', want ? 'Salvo' : 'Removido dos salvos'), kind: 'success' }); } catch {}
}

const _viewed = new Set();
export function markViewed(id) {
  const k = Number(id);
  if (!k || _viewed.has(k)) return;
  _viewed.add(k);
  _call('post_view', { id: k }, 'feed_view', { post_id: k }).then((r) => {
    const v = r && r.success && r.data ? r.data.view_count : null;
    if (v != null) patchPost(k, { views: Number(v) });
  }).catch(() => {});
}

/** Apagar o post (só o autor). Resolve true se apagou. */
export async function deletePost(id) {
  const k = Number(id);
  const r = await _call('post_delete', { id: k }, 'feed_delete_post', { post_id: k });
  if (!r || r.success === false) return false;
  markDeleted(k);
  try { require('react-native').DeviceEventEmitter.emit('chatyy:profilePostsChanged', { id: k, deleted: true }); } catch {}
  try { _api().swrInvalidate?.('profile_get'); } catch {}
  return true;
}
/** Editar texto/público (só o autor). Resolve { ok, error }. */
export async function editPost(id, { text, audience } = {}) {
  const k = Number(id);
  const prev = _posts.get(k);
  const params = { id: k };
  if (text != null) params.text = String(text);
  if (audience) params.audience = audience;
  if (prev) patchPost(k, { ...(text != null ? { caption: String(text) } : {}), ...(audience ? { audience } : {}) });
  const r = await _call('post_edit', params, text != null ? 'feed_edit_post' : null, { post_id: k, caption: String(text ?? '') });
  if (!r || r.success === false) {
    if (prev) patchPost(k, { caption: prev.caption, audience: prev.audience });
    return { ok: false, error: _errMsg(r) };
  }
  const raw = r.data && (r.data.post || null);
  if (raw) primePost({ ...raw, id: raw.id || k });
  try { require('react-native').DeviceEventEmitter.emit('chatyy:profilePostsChanged', { id: k, caption: text }); } catch {}
  return { ok: true };
}

// ─── Comentários ───────────────────────────────────────────────────────────
const _cm = new Map(); // postId -> { items, loading, loaded, hasMore, cursor, page, total, error }
const _cmSubs = new Map();
let _tmpSeq = 0;

function _normComment(c) {
  if (!c || typeof c !== 'object') return null;
  const au = c.author && typeof c.author === 'object' ? c.author : {};
  const replies = Array.isArray(c.replies) ? c.replies.map(_normComment).filter(Boolean) : [];
  const parent = c.parent_id ?? c.reply_to_id ?? null;
  return {
    id: c.id,
    post_id: c.post_id,
    email: au.email ?? c.email ?? c.author_email ?? '',
    name: au.name || c.name || c.author_name || '',
    username: au.username || c.username || '',
    avatar: au.avatar_url || au.avatar || c.avatar_url || c.avatar || '',
    content: String(c.text ?? c.content ?? ''),
    created_at: c.created_at || null,
    likes: _num(c.like_count, c.likes_count, c.likes),
    liked: !!(c.liked_by_me ?? c.liked),
    parent_id: parent ? parent : null,
    reply_count: c.reply_count != null ? Number(c.reply_count) : replies.length,
    is_mine: c.is_mine,
    can_delete: c.can_delete,
    replies,
    pending: !!c.pending,
    failed: !!c.failed,
    client_id: c.client_id || null,
  };
}
function _cmSet(k, s) {
  _cm.set(k, { ...s, _v: ((s && s._v) || 0) + 1 });
  const set = _cmSubs.get(k);
  if (set) for (const fn of Array.from(set)) { try { fn(); } catch {} }
}
export function getComments(postId) { return _cm.get(Number(postId)) || null; }
export function subscribeComments(postId, fn) {
  const k = Number(postId);
  if (!_cmSubs.has(k)) _cmSubs.set(k, new Set());
  _cmSubs.get(k).add(fn);
  _ensureWs();
  return () => { const s = _cmSubs.get(k); if (s) { s.delete(fn); if (!s.size) _cmSubs.delete(k); } };
}
export function useComments(postId) {
  const sub = useCallback((fn) => subscribeComments(postId, fn), [postId]);
  const snap = useCallback(() => getComments(postId), [postId]);
  return useSyncExternalStore(sub, snap, snap);
}
const _EMPTY = { items: [], loading: false, loaded: false, hasMore: false, cursor: null, page: 0, total: null };
function _isLocal(c) { return !!(c && (c.pending || c.failed)); }

/** Carrega (ou recarrega) a 1ª página; `more` = próxima página. */
export async function loadComments(postId, { more = false } = {}) {
  const k = Number(postId);
  if (!k) return;
  const prev = _cm.get(k) || _EMPTY;
  if (prev.loading) { if (!more) prev._reload = true; return; }
  if (more && !prev.hasMore) return;
  _cmSet(k, { ...prev, loading: true, error: null });
  const page = more ? (prev.page || 1) + 1 : 1;
  const params = { id: k, limit: 30 };
  if (more && prev.cursor) params.cursor = prev.cursor;
  const r = await _call('post_comments', params, 'feed_comments', { post_id: k, page });
  const cur = _cm.get(k) || prev;
  if (!r || r.success === false) {
    _cmSet(k, { ...cur, loading: false, error: _errMsg(r) || 'error' });
    return;
  }
  const d = r.data || {};
  const list = (Array.isArray(d.comments) ? d.comments : []).map(_normComment).filter(Boolean);
  const seen = new Set(list.map((c) => String(c.id)));
  let items;
  if (more) {
    items = cur.items.filter((c) => !_isLocal(c) && !seen.has(String(c.id))).concat(list);
  } else {
    // respostas que eu já tinha expandido (mais de 3) não somem no recarregar
    items = list.map((c) => {
      const old = cur.items.find((x) => String(x.id) === String(c.id));
      if (old && old.replies.length > c.replies.length) {
        const ids = new Set(c.replies.map((x) => String(x.id)));
        return { ...c, replies: c.replies.concat(old.replies.filter((x) => !_isLocal(x) && !ids.has(String(x.id)))) };
      }
      return c;
    });
  }
  // otimistas (enviando/falhou) continuam na tela
  for (const c of cur.items) {
    if (_isLocal(c)) { items.push(c); continue; }
    for (const rp of c.replies || []) {
      if (!_isLocal(rp)) continue;
      items = items.map((x) => (String(x.id) === String(rp.parent_id) && !x.replies.some((y) => y.id === rp.id) ? { ...x, replies: x.replies.concat([rp]) } : x));
    }
  }
  const total = d.comment_count != null ? Number(d.comment_count) : null;
  const next = { ...cur, items, loading: false, loaded: true, hasMore: !!d.has_more, cursor: d.next_cursor || null, page, total, error: null, viewer_is_owner: d.viewer_is_owner != null ? !!d.viewer_is_owner : cur.viewer_is_owner };
  const reload = cur._reload;
  delete next._reload;
  _cmSet(k, next);
  if (total != null) { const p = _posts.get(k); if (p && p.comments !== total) patchPost(k, { comments: total }); }
  if (reload) loadComments(k);
}

/** Mais respostas de um comentário (servidor manda até 3 junto). */
export async function loadReplies(postId, parent) {
  const k = Number(postId);
  if (!parent || !parent.id) return;
  const s = _cm.get(k);
  if (!s) return;
  const cursor = parent._rcursor || null;
  const params = { id: k, parent_id: parent.id, limit: 50 };
  if (cursor) params.cursor = cursor;
  const r = await _call('post_comments', params, null);
  if (!r || r.success === false) return;
  const d = r.data || {};
  const list = (Array.isArray(d.comments) ? d.comments : []).map(_normComment).filter(Boolean);
  const cur = _cm.get(k);
  if (!cur) return;
  _cmSet(k, {
    ...cur,
    items: cur.items.map((c) => {
      if (String(c.id) !== String(parent.id)) return c;
      const ids = new Set(list.map((x) => String(x.id)));
      const kept = c.replies.filter((x) => !ids.has(String(x.id)));
      const merged = (cursor ? kept.filter((x) => !_isLocal(x)).concat(list) : list).concat(kept.filter(_isLocal));
      return { ...c, replies: merged, reply_count: Math.max(c.reply_count || 0, merged.filter((x) => !_isLocal(x)).length), _rcursor: d.next_cursor || null, _rmore: !!d.has_more };
    }),
  });
}

function _mapComments(k, fn) {
  const s = _cm.get(k);
  if (!s) return;
  const items = [];
  for (const c of s.items) {
    const r = fn(c, null);
    if (r === null) continue;
    const base = r || c;
    const replies = [];
    for (const rp of base.replies || []) {
      const rr = fn(rp, base);
      if (rr === null) continue;
      replies.push(rr || rp);
    }
    items.push({ ...base, replies });
  }
  _cmSet(k, { ...s, items });
}
function _bumpCount(k, delta) {
  const p = _posts.get(k);
  if (p) patchPost(k, { comments: Math.max(0, (p.comments || 0) + delta) });
  const s = _cm.get(k);
  if (s && s.total != null) _cm.set(k, { ...s, total: Math.max(0, s.total + delta) });
}

/**
 * Comentar (otimista). `replyTo` = comentário que estou respondendo (raiz ou
 * resposta: o servidor normaliza para a raiz). Resolve { ok, error }.
 */
export async function addComment(postId, text, { replyTo = null, me = {} } = {}) {
  const k = Number(postId);
  const content = String(text || '').trim().slice(0, 1000);
  if (!k || !content) return { ok: false };
  if (!_cm.get(k)) _cm.set(k, { ..._EMPTY });
  const clientId = `mc${Date.now().toString(36)}${(++_tmpSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const rootId = replyTo ? (replyTo.parent_id || replyTo.id) : null;
  const tmp = _normComment({
    id: `tmp_${clientId}`, post_id: k, author: { email: me.email || '', name: me.name || '', avatar_url: me.avatar || '' },
    text: content, created_at: new Date().toISOString(), parent_id: rootId, pending: true, client_id: clientId,
    is_mine: true, can_delete: true,
  });
  const s = _cm.get(k);
  if (rootId) {
    _cmSet(k, { ...s, items: s.items.map((c) => (String(c.id) === String(rootId) ? { ...c, replies: (c.replies || []).concat([tmp]), reply_count: (c.reply_count || 0) + 1 } : c)) });
  } else {
    _cmSet(k, { ...s, items: s.items.concat([tmp]) });
  }
  _bumpCount(k, 1);
  try { require('./haptics').hapticEvent?.('send'); } catch {}
  return _sendComment(k, tmp);
}
async function _sendComment(k, tmp) {
  const rootId = tmp.parent_id;
  const params = { id: k, text: tmp.content, client_id: tmp.client_id };
  if (rootId) params.parent_id = rootId;
  const r = await _call('post_comment_create', params, 'feed_comment', { post_id: k, content: tmp.content, reply_to_id: rootId || null });
  if (!r || r.success === false) {
    const err = _errMsg(r);
    _mapComments(k, (c) => (c.id === tmp.id ? { ...c, pending: false, failed: true, error: err } : undefined));
    _bumpCount(k, -1);
    return { ok: false, error: err };
  }
  const d = r.data || {};
  const real = _normComment({ ...(d.comment || d), parent_id: (d.comment && d.comment.parent_id) || rootId });
  _mapComments(k, (c) => {
    if (c.id !== tmp.id) return undefined;
    return { ...c, ...real, id: real.id || c.id, content: real.content || c.content, name: real.name || c.name, email: real.email || c.email, avatar: real.avatar || c.avatar, replies: c.replies, pending: false, failed: false, is_mine: true, can_delete: real.can_delete !== false };
  });
  if (d.comment_count != null) { const p = _posts.get(k); if (p) patchPost(k, { comments: Number(d.comment_count) }); }
  return { ok: true, comment: real };
}
/** Re-tenta um comentário que falhou (mesmo client_id = sem duplicar). */
export function retryComment(postId, comment) {
  const k = Number(postId);
  if (!comment || !comment.failed) return;
  _mapComments(k, (c) => (c.id === comment.id ? { ...c, pending: true, failed: false } : undefined));
  _bumpCount(k, 1);
  _sendComment(k, { ...comment, pending: true, failed: false });
}

export async function toggleCommentLike(postId, comment) {
  const k = Number(postId);
  if (!comment || _isLocal(comment) || String(comment.id).startsWith('tmp')) return;
  const want = !comment.liked;
  const base = { liked: comment.liked, likes: comment.likes };
  _mapComments(k, (c) => (c.id === comment.id ? { ...c, liked: want, likes: Math.max(0, (c.likes || 0) + (want ? 1 : -1)) } : undefined));
  try { require('./haptics').hapticEvent?.(want ? 'like' : 'tap'); } catch {}
  const r = await _call('post_comment_like', { comment_id: comment.id, like: want ? 1 : 0 }, 'feed_comment_like_toggle', { comment_id: comment.id });
  if (!r || r.success === false) {
    _mapComments(k, (c) => (c.id === comment.id ? { ...c, ...base } : undefined));
    return;
  }
  const d = r.data || {};
  const cnt = d.like_count != null ? Number(d.like_count) : (d.likes_count != null ? Number(d.likes_count) : null);
  const liked = d.liked != null ? !!d.liked : want;
  _mapComments(k, (c) => (c.id === comment.id ? { ...c, liked, ...(cnt != null ? { likes: cnt } : {}) } : undefined));
}

export async function deleteComment(postId, comment) {
  const k = Number(postId);
  if (!comment) return false;
  const snap = _cm.get(k);
  const removed = comment.failed ? 0 : 1 + (!comment.parent_id ? (comment.reply_count || (comment.replies || []).length) : 0);
  _mapComments(k, (c) => (c.id === comment.id ? null : undefined));
  if (comment.parent_id) _mapComments(k, (c) => (String(c.id) === String(comment.parent_id) ? { ...c, reply_count: Math.max(0, (c.reply_count || 1) - 1) } : undefined));
  if (removed) _bumpCount(k, -removed);
  if (comment.failed || String(comment.id).startsWith('tmp')) return true;
  const r = await _call('post_comment_delete', { comment_id: comment.id }, 'feed_delete_comment', { comment_id: comment.id });
  if (!r || r.success === false) {
    if (snap) _cmSet(k, snap);
    if (removed) _bumpCount(k, removed);
    try { require('../components/ui/Toast').showToast({ message: _tr('mural.err.deleteComment', 'Não foi possível apagar o comentário'), kind: 'error' }); } catch {}
    return false;
  }
  const d = r.data || {};
  if (d.comment_count != null) { const p = _posts.get(k); if (p) patchPost(k, { comments: Number(d.comment_count) }); }
  return true;
}

// ─── Ao vivo [mural-rt 2026-10-22] ─────────────────────────────────────────
// Assinatura EXPLÍCITA por post no servidor (post_rt_sub: checa a permissão na hora — audiência, perfil
// privado, bloqueio) e eventos no canal por-usuário do WS: post_like / post_comment / post_update (com seq
// por post → replay do resume e fora de ordem são descartados). Antes: subscribe('feed_post_<id>'), que o hub
// não aceita → nada chegava. Repinta no máx. 1x a cada 250 ms por post. Renova a cada 30 s em 1º plano
// (a mesma chamada traz contadores frescos); WS fora / servidor sem tempo real → polling leve (20 s).
// Kill local: globalThis.__chatyy_mural_rt_off = true.
let _wsOn = false;
const _watch = new Map(); // id -> refcount
const _cmTimers = new Map();
const _seq = new Map(); // id -> último seq aplicado
const _fl = new Map(); // id -> { patch, ops, timer, last }
const _liveSubs = new Set();
const _rt = { sid: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, timer: null, next: null, inflight: false, again: false, unsub: new Set(), denied: new Set(), unsupported: false, on: true, renewMs: 30000, pollMs: 20000, active: true };
function _ws() { try { return require('./websocket').default; } catch { return null; } }
function _rtOff() { try { return !!globalThis.__chatyy_mural_rt_off; } catch { return false; } }
function _wsUp() { const w = _ws(); return !!(w && w.isConnected && w.authenticated); }
function _myEmail() { try { return String(_ws()?.email || '').toLowerCase(); } catch { return ''; } }

/** Assina o post enquanto ele/folha/linha do feed estiver na tela. Devolve o "desassinar". */
export function watchPost(id) {
  const k = Number(id);
  if (!k) return () => {};
  _ensureWs();
  const n = (_watch.get(k) || 0) + 1;
  _watch.set(k, n);
  if (n === 1) { _rt.unsub.delete(k); _rtKick(250); }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const m = (_watch.get(k) || 1) - 1;
    if (m <= 0) { _watch.delete(k); _rt.denied.delete(k); _rt.unsub.add(k); _rtKick(1500); } else _watch.set(k, m);
  };
}
/** fn(id, { likes, comments, liked? }) a cada atualização ao vivo aplicada (listas com estado próprio, ex. perfil). */
export function onLiveCounts(fn) { _liveSubs.add(fn); _ensureWs(); return () => _liveSubs.delete(fn); }

function _rtKick(ms) {
  if (_rt.unsupported) return;
  const at = Date.now() + ms;
  if (_rt.timer && _rt.next != null && _rt.next <= at) return;
  clearTimeout(_rt.timer);
  _rt.next = at;
  _rt.timer = setTimeout(() => { _rt.timer = null; _rt.next = null; _rtSync(); }, ms);
}
function _rtSchedule() {
  if (_rt.unsupported || !_rt.active || (!_watch.size && !_rt.unsub.size)) return;
  _rtKick(_rt.on && _wsUp() && !_rtOff() ? _rt.renewMs : _rt.pollMs);
}
async function _rtSync() {
  if (_rt.unsupported) return;
  if (_rt.inflight) { _rt.again = true; return; }
  const ids = Array.from(_watch.keys()).filter((k) => !_rt.denied.has(k)).slice(-60);
  const unsub = Array.from(_rt.unsub).slice(0, 200);
  if (!_rt.active && !unsub.length) return;
  if (!ids.length && !unsub.length) return;
  for (const k of unsub) _rt.unsub.delete(k);
  _rt.inflight = true;
  let r = null;
  try { r = await _api().apiCall('post_rt_sub', { ids: _rt.active ? ids : [], unsub, sid: _rt.sid }, 'POST'); } catch { r = null; }
  _rt.inflight = false;
  if (r && r.success === false && _UNKNOWN_RE.test(_errMsg(r))) { _rt.unsupported = true; return; } // servidor velho: só refetch ao focar
  const d = r && r.success && r.data ? r.data : null;
  if (d) {
    _rt.on = d.rt !== false;
    if (Number(d.renew_ms) >= 5000) _rt.renewMs = Number(d.renew_ms);
    if (Number(d.poll_ms) >= 5000) _rt.pollMs = Number(d.poll_ms);
    for (const k of Array.isArray(d.denied) ? d.denied : []) _rt.denied.add(Number(k));
    const st = d.stats && typeof d.stats === 'object' ? d.stats : {};
    for (const key of Object.keys(st)) _applySnap(Number(key), st[key]);
  }
  if (_rt.again) { _rt.again = false; _rtKick(50); return; }
  _rtSchedule();
}
// Foto dos contadores (renovação/polling): só vale se não for mais velha que o último evento aplicado.
function _applySnap(k, s) {
  if (!k || !s) return;
  const seq = Number(s.seq) || 0;
  const last = _seq.get(k) || 0;
  if (seq < last) return;
  if (seq) _seq.set(k, seq);
  const patch = {};
  if (s.like_count != null && !_likeOps.has(k)) { patch.likes = Number(s.like_count); if (s.liked_by_me != null) patch.liked = !!s.liked_by_me; }
  if (s.comment_count != null) patch.comments = Number(s.comment_count);
  _queue(k, patch, null);
  // perdeu comentários com o WS fora (folha aberta e o número não bate) → recarrega a lista
  const cs = _cm.get(k);
  if (s.comment_count != null && cs && cs.loaded && cs.total != null && Number(s.comment_count) !== cs.total && (_cmSubs.get(k)?.size || 0) > 0) {
    clearTimeout(_cmTimers.get(k));
    _cmTimers.set(k, setTimeout(() => { _cmTimers.delete(k); loadComments(k); }, 300));
  }
}
function _seqOk(k, seq) {
  const n = Number(seq) || 0;
  if (!n) return true;
  if (n <= (_seq.get(k) || 0)) return false;
  _seq.set(k, n);
  return true;
}
// Coalescência: 1 repintura a cada 250 ms por post (a 1ª sai já; as seguintes juntam).
function _queue(k, patch, op) {
  if (!k) return;
  let f = _fl.get(k);
  if (!f) { f = { patch: {}, ops: [], timer: null, last: 0 }; _fl.set(k, f); }
  if (patch) Object.assign(f.patch, patch);
  if (op) f.ops.push(op);
  if (f.timer) return;
  f.timer = setTimeout(() => _flushNow(k), Math.max(0, f.last + 250 - Date.now()));
}
function _flushNow(k) {
  const f = _fl.get(k);
  if (!f) return;
  f.timer = null;
  f.last = Date.now();
  const patch = f.patch; const ops = f.ops;
  f.patch = {}; f.ops = [];
  if (ops.length && _cm.has(k)) _applyCmOps(k, ops);
  const p = _posts.get(k);
  if (p && !p.deleted) {
    const diff = {};
    for (const key of Object.keys(patch)) if (p[key] !== patch[key]) diff[key] = patch[key];
    if (diff.likes != null) diff.likes_text = ''; // texto pronto do servidor ficou velho → likersText recalcula
    if (Object.keys(diff).length) patchPost(k, diff);
  }
  if (Object.keys(patch).length) for (const fn of Array.from(_liveSubs)) { try { fn(k, patch); } catch {} }
}
function _applyCmOps(k, ops) {
  const s = _cm.get(k);
  if (!s) return;
  let items = s.items;
  let total = s.total;
  const me = _myEmail();
  const post = _posts.get(k);
  for (const op of ops) {
    if (op.total != null) total = op.total;
    if (op.kind === 'new') {
      const c = op.c;
      if (!c || c.id == null) continue;
      const sid = String(c.id);
      const has = (x) => String(x.id) === sid || (op.clientId && x.client_id === op.clientId);
      if (items.some((x) => has(x) || (x.replies || []).some(has))) continue; // eco do meu (otimista/retorno do POST já pôs)
      const mine = !!me && String(c.email || '').toLowerCase() === me;
      const nc = { ...c, is_mine: mine, can_delete: mine || !!(post && post.is_mine), liked: false };
      if (c.parent_id) {
        if (!items.some((x) => String(x.id) === String(c.parent_id))) continue;
        items = items.map((x) => (String(x.id) === String(c.parent_id) ? { ...x, replies: (x.replies || []).concat([nc]), reply_count: (x.reply_count || 0) + 1 } : x));
      } else {
        if (s.hasMore) continue; // páginas no meio ainda não carregadas: aparece ao paginar (só o número sobe)
        const at = items.findIndex((x) => _isLocal(x) || Number(x.id) > Number(c.id)); // ordem do servidor (id crescente), antes dos meus em envio
        items = at < 0 ? items.concat([nc]) : items.slice(0, at).concat([nc], items.slice(at));
      }
    } else if (op.kind === 'del') {
      const sid = String(op.id);
      if (!items.some((x) => String(x.id) === sid || (x.replies || []).some((y) => String(y.id) === sid))) continue; // já tirei (otimista)
      items = items.filter((x) => String(x.id) !== sid).map((x) => {
        if (!(x.replies || []).some((y) => String(y.id) === sid)) return x;
        return { ...x, replies: x.replies.filter((y) => String(y.id) !== sid), reply_count: Math.max(0, (x.reply_count || 1) - 1) };
      });
    }
  }
  if (items === s.items && total === s.total) return;
  _cmSet(k, { ...s, items, total });
}
function _evData(m) { return m && m.post_id != null ? m : (m && m.data && m.data.post_id != null ? m.data : null); }

function _ensureWs() {
  if (_wsOn) return;
  const ws = _ws();
  if (!ws || typeof ws.on !== 'function') return;
  _wsOn = true;
  ws.on('post_like', (m) => {
    if (_rtOff()) return;
    const d = _evData(m);
    const k = d ? Number(d.post_id) : 0;
    if (!k || !_seqOk(k, d.seq)) return;
    const patch = {};
    if (d.like_count != null && !_likeOps.has(k)) patch.likes = Number(d.like_count);
    if (d.actor_is_me && d.liked != null && !_likeOps.has(k)) patch.liked = !!d.liked; // eco do meu outro aparelho
    if (d.comment_count != null) patch.comments = Number(d.comment_count);
    _queue(k, patch, null);
  });
  ws.on('post_comment', (m) => {
    if (_rtOff()) return;
    const d = _evData(m);
    const k = d ? Number(d.post_id) : 0;
    if (!k || !_seqOk(k, d.seq)) return;
    const total = d.comment_count != null ? Number(d.comment_count) : null;
    const patch = {};
    if (total != null) patch.comments = total;
    if (d.like_count != null && !_likeOps.has(k)) patch.likes = Number(d.like_count);
    let op = null;
    if (d.op === 'new' && d.comment) {
      const c = _normComment({ ...d.comment, parent_id: d.comment.parent_id ?? d.parent_id ?? null });
      if (c) op = { kind: 'new', c, clientId: d.client_id || null, total };
    } else if (d.op === 'deleted' && d.comment_id != null) {
      op = { kind: 'del', id: d.comment_id, total };
    }
    // meu comentário em voo: o retorno do POST resolve o otimista; o eco só não pode duplicar (client_id)
    _queue(k, patch, op);
  });
  ws.on('post_update', (m) => {
    const d = _evData(m);
    const k = d ? Number(d.post_id) : 0;
    if (!k || !_seqOk(k, d.seq)) return;
    const reason = String(d.reason || '');
    if (reason === 'delete') { if (_posts.has(k)) markDeleted(k); return; }
    if (reason === 'edit') { if (_posts.has(k)) loadPost(k); if (_watch.has(k)) _rtKick(800); return; } // servidor zera assinantes no edit (público pode ter mudado) → re-assina
    const patch = {};
    if (d.like_count != null && !_likeOps.has(k)) patch.likes = Number(d.like_count);
    if (d.comment_count != null) patch.comments = Number(d.comment_count);
    _queue(k, patch, null);
  });
  // WS voltou → re-assina já (traz os números que mudaram enquanto caiu); caiu → próximo ciclo vira polling
  ws.on('connection', (e) => {
    const st = e && e.status;
    if (st === 'authenticated' || st === 'connected') { if (_watch.size) _rtKick(400); }
    else if (st === 'disconnected' || st === 'offline') { if (_watch.size) _rtKick(_rt.pollMs); }
  });
  try {
    const { AppState } = require('react-native');
    AppState.addEventListener('change', (s) => {
      const act = s === 'active';
      if (act === _rt.active) return;
      _rt.active = act;
      if (act) { if (_watch.size) _rtKick(300); return; }
      // 2º plano: desassina tudo (sem eventos à toa no fundo; servidor expira sozinho de qualquer jeito)
      clearTimeout(_rt.timer); _rt.timer = null; _rt.next = null;
      for (const k of _watch.keys()) _rt.unsub.add(k);
      _rtSync();
    });
  } catch {}
}

// ─── Texto ─────────────────────────────────────────────────────────────────
function _tr(key, fb) {
  try {
    const { lookupKey } = require('../i18n');
    const lang = (require('./api').getAuthHeaders?.() || {})['X-User-Language'] || 'pt-BR';
    const s = lookupKey ? lookupKey(lang, key) : null;
    return typeof s === 'string' ? s : fb;
  } catch { return fb; }
}

export default {
  getPost, primePost, patchPost, subscribePost, usePost, loadPost, onAnyPostChange, markDeleted,
  toggleLike, toggleSave, markViewed, normalizePost, deletePost, editPost, watchPost, onLiveCounts,
  getComments, subscribeComments, useComments, loadComments, loadReplies, addComment, retryComment, toggleCommentLike, deleteComment,
};
