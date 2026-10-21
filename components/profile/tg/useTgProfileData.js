// [mural 2026-10-20] Dados do perfil novo (Telegram + Mural) — contrato
// /root/mural-2026-10-20/API.md:
//   profile_get             identidade, presença, stories, common_chats (já existia)
//   profile_note_get        nota do dono {email}
//   profile_posts           mural por autor, cursor + counts (1ª página)
//   profile_shared_counts   conversation_id da DM + contagens das abas
//   profile_common_groups   grupos em comum
//   chat_shared_items       Mídia / Links / Docs / Voz (cursor)
// Servidor antigo (ação desconhecida) → feed_user_posts (página) / common_chats.
// Cópia em memória por e-mail: reabrir o perfil pinta na hora e revalida.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';

const PAGE = 24;
const FIRST_PAGE = 12; // [muralperf 2026-10-21] 1ª página pequena (4 linhas da grade = 1 tela) → chega antes; o resto vem rolando
const SHARED_PAGE = 60;
const _mem = new Map(); // email → { profile, note, posts:{items,cursor,hasMore,page,legacy}, counts, shared }

// [muralperf 2026-10-21] cópia em DISCO (MMKV, leitura síncrona) por e-mail: abrir o perfil depois de fechar o app
// pinta na hora (identidade + grade + contadores) e revalida por trás — antes só a cópia em memória da sessão.
// Guarda os posts CRUS do servidor (≤ FIRST_PAGE, ~1 KB cada) e normaliza de novo ao ler. TTL 7 dias, chave por conta.
const DISK_TTL = 7 * 86400000;
const _diskKey = (k) => `tgprof_v1_${k}`;
function _diskRead(k) {
  if (!k) return null;
  try {
    const d = require('../../../services/cache').getCachedSync(_diskKey(k));
    if (!d || typeof d !== 'object') return null;
    const items = Array.isArray(d.postsRaw) ? d.postsRaw.map(normPost).filter(Boolean) : [];
    return {
      profile: d.profile || null, note: d.note || null, counts: d.counts || null, groups: Array.isArray(d.groups) ? d.groups : null,
      posts: { items, cursor: d.cursor || null, hasMore: !!d.hasMore, page: 1, loading: false, loaded: items.length > 0 || !!d.postsLoaded, error: false, legacy: false, fromDisk: true },
    };
  } catch { return null; }
}
const _diskTimers = new Map();
function _diskWrite(k, entry) {
  if (!k || !entry) return;
  clearTimeout(_diskTimers.get(k));
  _diskTimers.set(k, setTimeout(() => {
    _diskTimers.delete(k);
    try {
      const ps = entry.posts || null;
      const postsRaw = ps && Array.isArray(ps.items) ? ps.items.filter((p) => p && !p.__pending).slice(0, FIRST_PAGE).map((p) => p.raw || p) : [];
      require('../../../services/cache').setCache(_diskKey(k), {
        // presença/stories mudam rápido → não vão para o disco (a cópia não mostra "online" velho)
        profile: entry.profile ? { ...entry.profile, presence: null, stories: [] } : null,
        note: entry.note || null, counts: entry.counts || null, groups: entry.groups || null,
        postsRaw, cursor: ps && postsRaw.length >= FIRST_PAGE ? (ps.items[postsRaw.length - 1] && String(ps.items[postsRaw.length - 1].id)) || null : null,
        hasMore: !!(ps && (ps.hasMore || ps.items.length > postsRaw.length)), postsLoaded: !!(ps && ps.loaded),
      }, DISK_TTL).catch(() => {});
    } catch {}
  }, 400));
}

function _api() { try { return require('../../../services/api'); } catch { return null; } }
async function _call(action, params) {
  const a = _api();
  if (!a || !a.apiCall) return null;
  try { return await a.apiCall(action, params || {}, 'POST'); } catch { return null; }
}

export function absUrl(u) {
  const s = String(u || '');
  if (!s) return '';
  if (/^(https?:|file:|content:|ph:|assets-library:|data:)/i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/')) {
    try { const a = _api(); if (a && a.getMediaUrl) return a.getMediaUrl(s); } catch {}
    return 'https://chatyy.com.br' + s;
  }
  return s;
}

const _isVidUrl = (u) => /\.(mp4|mov|webm|m4v|3gp)(\?|$)/i.test(String(u || ''));

/** Post de qualquer origem (profile_posts / feed_user_posts / fila) → formato único. */
export function normPost(p) {
  if (!p || p.id == null) return null;
  if (p.__norm) return p;
  let media = [];
  if (Array.isArray(p.media)) {
    // [muralperf 2026-10-21] thumb = miniatura da GRADE (grid = recorte 3:4 480x640 ~20-40 KB; t320 se não houver);
    // display = versão de tela do CARTÃO (≤1280, ~70-220 KB) em vez do original (0,4-1,4 MB); blurhash pinta na hora.
    media = p.media.filter((m) => m && m.url).map((m) => ({
      url: absUrl(m.url),
      thumb: absUrl(m.grid || m.t320 || m.thumb || m.url),
      display: absUrl(m.display || m.thumb || m.url),
      blurhash: m.blurhash || null,
      type: m.type === 'video' || _isVidUrl(m.url) ? 'video' : 'image', w: m.w || 0, h: m.h || 0,
    }));
  } else {
    let mu = p.media_urls;
    if (typeof mu === 'string') { try { mu = JSON.parse(mu); } catch { mu = mu ? [mu] : []; } }
    mu = Array.isArray(mu) ? mu.filter(Boolean) : [];
    const vidPost = String(p.media_type || p.type || '') === 'video' || String(p.media_type || '') === 'reel';
    const th = p.thumbnail_url || p.thumbnail || '';
    media = mu.map((u, i) => {
      const video = (i === 0 && vidPost) || _isVidUrl(u);
      return { url: absUrl(u), thumb: absUrl(i === 0 && th ? th : u), type: video ? 'video' : 'image', w: 0, h: 0 };
    });
    if (!media.length && th) media = [{ url: absUrl(th), thumb: absUrl(th), type: vidPost ? 'video' : 'image', w: 0, h: 0 }];
  }
  const text = String(p.text != null ? p.text : (p.caption || ''));
  const kind = p.kind || (media.length ? (text.trim() ? 'media_text' : 'media') : 'text');
  return {
    __norm: true,
    id: p.id,
    text,
    kind,
    media,
    created_at: p.created_at || null,
    audience: p.audience || 'public',
    like_count: Number(p.like_count != null ? p.like_count : (p.likes_count || 0)) || 0,
    liked_by_me: !!(p.liked_by_me != null ? p.liked_by_me : (p.liked || p.is_liked)),
    comment_count: Number(p.comment_count != null ? p.comment_count : (p.comments_count || 0)) || 0,
    view_count: Number(p.view_count || 0) || 0,
    likes_text: p.likes_text || '',
    author: p.author || (p.author_email ? { email: p.author_email, name: p.author_name || '' } : null),
    is_mine: !!p.is_mine,
    is_pinned: !!p.is_pinned,
    allow_comments: p.allow_comments !== false,
    style: p.style || p.bg || null,
    count: p.count || media.length,
    __pending: p.__pending,
    raw: p,
  };
}

// [muralperf 2026-10-21] baixa as miniaturas da grade (e a versão de tela das 3 primeiras, que abrem no toque)
// para o cache do expo-image assim que a página chega — a grade pinta sem buraco ao rolar.
function _prefetchThumbs(list) {
  try {
    const Img = require('expo-image').Image;
    if (!Img || !Img.prefetch) return;
    const urls = [];
    list.forEach((p, i) => {
      const m = p && p.media && p.media[0];
      if (!m || !/^https?:/i.test(m.thumb || '')) return;
      urls.push(m.thumb);
      if (i < 3 && m.display && m.display !== m.thumb && /^https?:/i.test(m.display)) urls.push(m.display);
    });
    if (urls.length) Img.prefetch(Array.from(new Set(urls)).slice(0, 40), 'memory-disk').catch(() => {});
  } catch {}
}

function _dedupe(base, add) {
  const seen = new Set(base.map((p) => String(p.id)));
  const out = base.slice();
  for (const p of add) { if (p && !seen.has(String(p.id))) { seen.add(String(p.id)); out.push(p); } }
  return out;
}

const EMPTY_SHARED = { items: [], cursor: null, hasMore: false, loading: false, loaded: false, error: false };
const SHARED_KINDS = { media: 'media', links: 'link', docs: 'doc', voice: 'audio' };

/**
 * useTgProfileData({ email, username, self, conversationId, enabled })
 * conversationId (opcional) = DM já conhecida (aberto da conversa).
 */
export function useTgProfileData({ email, username, self = false, conversationId = null, enabled = true }) {
  const key0 = String(email || username || '').toLowerCase();
  const mem0 = useMemo(() => {
    const m = _mem.get(key0);
    if (m) return m;
    const d = _diskRead(key0);
    if (d) _mem.set(key0, d);
    return d;
  }, [key0]); // eslint-disable-line react-hooks/exhaustive-deps
  const [profile, setProfile] = useState(mem0 ? mem0.profile : null);
  const [profileErr, setProfileErr] = useState(false);
  const [note, setNote] = useState(mem0 ? mem0.note : null);
  const [posts, setPosts] = useState(mem0 && mem0.posts ? mem0.posts : { items: [], cursor: null, hasMore: true, page: 0, loading: false, loaded: false, error: false, legacy: false });
  const [counts, setCounts] = useState(mem0 ? (mem0.counts || null) : null);
  const [shared, setShared] = useState(() => ({ media: EMPTY_SHARED, links: EMPTY_SHARED, docs: EMPTY_SHARED, voice: EMPTY_SHARED }));
  const [groups, setGroups] = useState(mem0 && mem0.groups ? mem0.groups : null);

  const resolvedEmail = String((profile && profile.identity && profile.identity.email) || email || '').toLowerCase();
  const selfEff = !!(self || (profile && profile.actions && profile.actions.is_self));
  const memKey = resolvedEmail || key0;
  const convId = conversationId || (counts && counts.conversation_id) || (() => {
    const cc = profile && Array.isArray(profile.common_chats) ? profile.common_chats : [];
    const d = cc.find((c) => c && c.type === 'direct');
    return d ? d.id : null;
  })();

  const save = useCallback((patch) => {
    if (!memKey) return;
    const cur = _mem.get(memKey) || {};
    const next = { ...cur, ...patch };
    _mem.set(memKey, next);
    if (key0 && key0 !== memKey) _mem.set(key0, next); // aberto por @usuário → a próxima abertura acha pela mesma chave
    if (_mem.size > 40) { const k = _mem.keys().next().value; _mem.delete(k); }
    _diskWrite(memKey, next);
    if (key0 && key0 !== memKey) _diskWrite(key0, next);
  }, [memKey, key0]);

  // ── profile_get ──
  const loadProfile = useCallback(async () => {
    const a = _api();
    if (!a || !(email || username)) return;
    setProfileErr(false);
    let r = null;
    try { r = await a.profileGet(email || username); } catch { r = null; }
    if (r && r.success && r.data) { setProfile(r.data); save({ profile: r.data }); }
    else setProfileErr(true);
  }, [email, username, save]);

  useEffect(() => { if (enabled) loadProfile(); }, [enabled, loadProfile]);

  // ── nota ──
  useEffect(() => {
    if (!enabled || !resolvedEmail) return undefined;
    let alive = true;
    _call('profile_note_get', { email: resolvedEmail }).then((r) => {
      if (!alive) return;
      const n = r && r.success && r.data ? r.data.note : null;
      const v = n && n.text ? n : null;
      setNote(v); save({ note: v });
    });
    return () => { alive = false; };
  }, [enabled, resolvedEmail, save]);

  // ── mural ──
  const reqRef = useRef(0);
  const postsRef = useRef(posts);
  postsRef.current = posts;
  const loadPosts = useCallback(async (more) => {
    if (!resolvedEmail) return;
    const st = postsRef.current;
    if (more && (!st.hasMore || st.loading)) return;
    const my = ++reqRef.current;
    // [muralperf 2026-10-21] revalidar com a grade já na tela (cópia) = calado: sem spinner no rodapé
    setPosts((s) => ({ ...s, loading: more || !s.items.length, refreshing: !more && !!s.items.length, error: false }));
    let list = null; let next = null; let hasMore = false; let cnt = null; let legacy = st.legacy; let page = more ? (st.page || 1) + 1 : 1;
    if (!legacy) {
      const params = { email: self ? '' : resolvedEmail, limit: more ? PAGE : FIRST_PAGE };
      if (more && st.cursor) params.cursor = st.cursor;
      const r = await _call('profile_posts', params);
      if (r && r.success && r.data && Array.isArray(r.data.posts)) {
        list = r.data.posts; next = r.data.next_cursor || null; hasMore = !!r.data.has_more && !!next; cnt = r.data.counts || null;
      } else if (!more) legacy = true;
    }
    if (legacy) {
      const a = _api();
      let r = null;
      try { r = a && a.feedUserPosts ? await a.feedUserPosts(resolvedEmail, page) : null; } catch { r = null; }
      if (r && r.success && r.data) { list = Array.isArray(r.data.posts) ? r.data.posts : []; hasMore = !!r.data.has_more; }
    }
    if (my !== reqRef.current) return;
    if (!list) { setPosts((s) => ({ ...s, loading: false, refreshing: false, error: !s.items.length, loaded: true })); return; }
    const norm = list.map(normPost).filter(Boolean);
    _prefetchThumbs(norm);
    setPosts((s) => {
      const items = more ? _dedupe(s.items, norm) : norm;
      const out = { items, cursor: next, hasMore, page, loading: false, refreshing: false, loaded: true, error: false, legacy };
      if (!more) save({ posts: out });
      return out;
    });
    if (cnt) setCounts((c) => { const v = { ...(c || {}), posts: cnt.posts, photos: cnt.photos, texts: cnt.texts }; save({ counts: v }); return v; });
  }, [resolvedEmail, self, save]);

  useEffect(() => { if (enabled && resolvedEmail) loadPosts(false); }, [enabled, resolvedEmail, loadPosts]);

  // Publicou (qualquer compositor) / fila confirmou → recarrega a 1ª página.
  useEffect(() => {
    if (!selfEff || !enabled) return undefined;
    const subs = [];
    try { subs.push(DeviceEventEmitter.addListener('chatyy:profilePostsChanged', () => loadPosts(false))); } catch {}
    try { const q = require('../../../services/profilePostQueue'); subs.push({ remove: q.onProfilePostPublished(() => loadPosts(false)) }); } catch {}
    return () => { for (const s of subs) { try { s.remove(); } catch {} } };
  }, [selfEff, enabled, loadPosts]);

  // ── contagens das abas ──
  useEffect(() => {
    if (!enabled || !resolvedEmail || selfEff) return undefined;
    let alive = true;
    _call('profile_shared_counts', { email: resolvedEmail }).then((r) => {
      if (!alive || !r || !r.success || !r.data) return;
      setCounts((c) => { const v = { ...(c || {}), ...r.data }; save({ counts: v }); return v; });
    });
    return () => { alive = false; };
  }, [enabled, resolvedEmail, selfEff, save]);

  // ── grupos em comum ──
  const loadGroups = useCallback(async () => {
    if (!resolvedEmail || self) return;
    const r = await _call('profile_common_groups', { email: resolvedEmail });
    if (r && r.success && r.data && Array.isArray(r.data.groups)) { setGroups(r.data.groups); save({ groups: r.data.groups }); return; }
    const cc = profile && Array.isArray(profile.common_chats) ? profile.common_chats : [];
    const g = cc.filter((c) => c && c.type === 'group').map((c) => ({ id: c.id, name: c.name, avatar_url: c.avatar || c.avatar_url || '', member_count: c.member_count || c.members_count || 0 }));
    setGroups(g);
  }, [resolvedEmail, self, profile, save]);

  // ── Mídia / Links / Docs / Voz ──
  const sharedRef = useRef(shared);
  sharedRef.current = shared;
  const sharedSeq = useRef({});
  const loadShared = useCallback(async (tab, more) => {
    const kind = SHARED_KINDS[tab];
    if (!kind || !convId) return;
    const st = sharedRef.current[tab] || EMPTY_SHARED;
    if (st.loading) return;
    if (more && (!st.hasMore || !st.cursor)) return;
    if (!more && st.loaded) return;
    const seq = (sharedSeq.current[tab] = (sharedSeq.current[tab] || 0) + 1);
    setShared((s) => ({ ...s, [tab]: { ...(s[tab] || EMPTY_SHARED), loading: true, error: false } }));
    const a = _api();
    let r = null;
    try { r = a && a.chatSharedItems ? await a.chatSharedItems(convId, kind, more ? st.cursor : '', SHARED_PAGE) : null; } catch { r = null; }
    if (seq !== sharedSeq.current[tab]) return;
    if (!r || !r.success) {
      // servidor velho: galeria antiga (sem links)
      if (!more && kind !== 'link' && a && a.chatMediaGallery) {
        try {
          const kinds = kind === 'media' ? ['image', 'video'] : [kind === 'doc' ? 'file' : kind];
          const all = [];
          for (const k of kinds) { const g = await a.chatMediaGallery(convId, k).catch(() => null); if (g && g.success && g.data && Array.isArray(g.data.items)) all.push(...g.data.items); }
          all.sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')));
          r = { success: true, data: { items: all, has_more: false } };
        } catch { r = null; }
      }
    }
    if (seq !== sharedSeq.current[tab]) return;
    if (!r || !r.success) { setShared((s) => ({ ...s, [tab]: { ...(s[tab] || EMPTY_SHARED), loading: false, loaded: true, error: true } })); return; }
    const add = Array.isArray(r.data && r.data.items) ? r.data.items : [];
    setShared((s) => {
      const prev = s[tab] || EMPTY_SHARED;
      const base = more ? prev.items : [];
      const seen = new Set(base.map((x) => `${x.id}|${x.url || ''}`));
      const items = base.slice();
      for (const it of add) { const k = `${it.id}|${it.url || ''}`; if (!seen.has(k)) { seen.add(k); items.push(it); } }
      return { ...s, [tab]: { items, cursor: r.data && r.data.has_more ? (r.data.next_cursor || null) : null, hasMore: !!(r.data && r.data.has_more && r.data.next_cursor), loading: false, loaded: true, error: false } };
    });
  }, [convId]);

  // conversa mudou (DM descoberta depois) → zera as abas
  useEffect(() => { setShared({ media: EMPTY_SHARED, links: EMPTY_SHARED, docs: EMPTY_SHARED, voice: EMPTY_SHARED }); }, [convId]);

  const reloadShared = useCallback((tab) => {
    setShared((s) => ({ ...s, [tab]: EMPTY_SHARED }));
    setTimeout(() => loadShared(tab, false), 0);
  }, [loadShared]);

  // Patch local de um post (curtida otimista etc.).
  const patchPost = useCallback((id, patch) => {
    setPosts((s) => ({ ...s, items: s.items.map((p) => (String(p.id) === String(id) ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } : p)) }));
  }, []);
  const removePost = useCallback((id) => {
    setPosts((s) => ({ ...s, items: s.items.filter((p) => String(p.id) !== String(id)) }));
    setCounts((c) => (c && c.posts ? { ...c, posts: Math.max(0, c.posts - 1) } : c));
  }, []);

  return useMemo(() => ({
    email: resolvedEmail,
    profile, profileErr, reloadProfile: loadProfile,
    identity: (profile && profile.identity) || null,
    presence: (profile && profile.presence) || null,
    stories: (profile && Array.isArray(profile.stories)) ? profile.stories : [],
    isSelf: !!(self || (profile && profile.actions && profile.actions.is_self)),
    note,
    posts, loadMorePosts: () => loadPosts(true), reloadPosts: () => loadPosts(false),
    patchPost, removePost,
    counts,
    conversationId: convId,
    shared, loadShared, reloadShared,
    groups, loadGroups,
  }), [resolvedEmail, profile, profileErr, loadProfile, self, note, posts, loadPosts, patchPost, removePost, counts, convId, shared, loadShared, reloadShared, groups, loadGroups]);
}

/** Curtir/descurtir (post_like idempotente; servidor velho = feed_like alterna). */
export async function likePost(id, like) {
  const r = await _call('post_like', { id, like: like ? 1 : 0 });
  if (r && r.success && r.data) return { ok: true, liked: !!r.data.liked, like_count: Number(r.data.like_count) || 0, likes_text: r.data.likes_text || '' };
  const a = _api();
  try { const r2 = a && a.feedLike ? await a.feedLike(id) : null; if (r2 && r2.success) return { ok: true }; } catch {}
  return { ok: false };
}

export async function deletePost(id) {
  const r = await _call('post_delete', { id });
  if (r && r.success) return true;
  const a = _api();
  try { const r2 = a && a.feedDeletePost ? await a.feedDeletePost(id) : null; return !!(r2 && r2.success); } catch { return false; }
}

export async function reportPost(id, reason) {
  const r = await _call('mod_report', { content_type: 'post', content_id: id, reason: reason || 'inappropriate' });
  return !!(r && r.success);
}
