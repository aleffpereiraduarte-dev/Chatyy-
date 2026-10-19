// components/profile/contactProfileExtras.js — [perfil-fotos 2026-10-19]
//
// "Dados do contato" (aberto da conversa) ganha o que o perfil do Telegram tem:
//   • galeria de fotos do perfil: carrossel no cabeçalho (deslizar na foto
//     expandida com ChatInfo api ≥ 6) e toque no avatar → galeria em tela cheia;
//   • "Publicações": linha com a contagem (abre o perfil) e, com api ≥ 6, a grade
//     3 colunas NATIVA no fim (prop gridMedia, separada da faixa "Mídia, links e
//     docs"), paginada por onMediaEnd, toque → visualizador nativo.
// Visitante sem publicações não vê nada. Privacidade = servidor (profile_photos
// respeita a foto de perfil todos/contatos/ninguém; feed_user_posts o público
// de cada publicação + bloqueio).
//
// Kill switches: globalThis.__chatyy_profile_gallery = false,
//                globalThis.__chatyy_profile_posts_ci = false.
import { useCallback, useEffect, useRef, useState } from 'react';
import * as PP from '../../services/profilePhotos';

function _abs(u) {
  const s = String(u || '');
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (s.startsWith('/')) return 'https://chatyy.com.br' + s;
  return s;
}

function _isVideo(p) {
  const ty = String(p?.media_type || p?.type || '');
  return ty === 'video' || ty === 'reel' || /video/.test(ty);
}

function _thumb(p) {
  const raw = p?.thumbnail || p?.thumbnail_url || (Array.isArray(p?.media_urls) ? p.media_urls[0] : '') || p?.url || '';
  return _abs(raw);
}

function _postItem(p, name) {
  const mu = Array.isArray(p?.media_urls) ? p.media_urls : [];
  const isVid = _isVideo(p);
  const main = _abs(mu[0] || (isVid ? (p?.video_url || '') : (p?.url || p?.thumbnail_url || '')));
  if (!main || /\/api\//.test(main)) return null;
  const video = isVid || /\.(mp4|mov|webm|m4v|3gp)(\?|$)/i.test(main);
  const th = p?.thumbnail_url || p?.thumbnail || '';
  return { uri: main, thumbUri: th ? _abs(th) : null, type: video ? 'video' : 'image', caption: String(p?.caption || '').slice(0, 300), senderName: String(name || ''), createdAt: p?.created_at || null };
}

/** Fotos da galeria + publicações do contato (só busca com `enabled`). */
export function useContactProfileExtras(email, enabled) {
  const em = String(email || '').trim().toLowerCase();
  const galOn = PP.isProfileGalleryEnabled();
  const postsOn = PP.isProfilePostsCiEnabled();
  const [photos, setPhotos] = useState(() => (em ? (PP.getCachedProfilePhotos(em)?.photos || []) : []));
  const [posts, setPosts] = useState({ email: '', items: [], page: 0, hasMore: false, loading: false });
  const reqRef = useRef(0);

  useEffect(() => {
    if (!enabled || !em || !galOn) return undefined;
    let alive = true;
    PP.fetchProfilePhotos(em).then((r) => { if (alive && r) setPhotos(r.photos || []); }).catch(() => {});
    return () => { alive = false; };
  }, [enabled, em, galOn]);

  const loadPage = useCallback(async (page) => {
    if (!em) return;
    const my = ++reqRef.current;
    setPosts((s) => ({ ...s, email: em, loading: true }));
    let r = null;
    try { r = await require('../../services/api').feedUserPosts(em, page); } catch { r = null; }
    if (my !== reqRef.current) return;
    const list = r && r.success && Array.isArray(r.data?.posts) ? r.data.posts : [];
    setPosts((s) => {
      const base = page > 1 && s.email === em ? s.items : [];
      const seen = new Set(base.map((p) => String(p.id)));
      const add = list.filter((p) => p && p.id != null && !seen.has(String(p.id)));
      return { email: em, items: base.concat(add), page, hasMore: !!(r && r.data && r.data.has_more), loading: false };
    });
  }, [em]);

  useEffect(() => {
    if (!enabled || !em || !postsOn) return;
    loadPage(1);
  }, [enabled, em, postsOn, loadPage]);

  const stRef = useRef(posts);
  stRef.current = posts;
  const loadMore = useCallback(() => {
    const s = stRef.current;
    if (!s.hasMore || s.loading) return;
    loadPage((s.page || 1) + 1);
  }, [loadPage]);

  return {
    email: em,
    photos: galOn && enabled ? photos : [],
    posts: postsOn && enabled && posts.email === em ? posts.items : [],
    hasMore: posts.hasMore,
    loadMore,
  };
}

/**
 * Acrescenta galeria + publicações aos descritores de buildContactChatInfo().
 * ctx = { t, router, peerName, v5, v6 } — v5/v6 = ChatInfo api do binário.
 */
export function decorateContactChatInfo(info, extras, ctx = {}) {
  if (!info || !extras || !extras.email) return info;
  const t = ctx.t;
  const out = { ...info };
  const hero = { ...(info.hero || {}) };
  const origAvatar = hero.onAvatarPress;
  const photos = Array.isArray(extras.photos) ? extras.photos : [];
  const name = String(ctx.peerName || hero.title || '');

  // ── Galeria ──
  if (photos.length > 0) {
    const extra = PP.heroExtraPhotos(photos, ctx.v6 ? 20 : 8);
    if (extra.length) {
      hero.photos = extra;
      if (ctx.v6) hero.swipe = 1;
    }
    hero.onAvatarPress = (index) => {
      let avatarUrl = '';
      try { avatarUrl = require('../chat/NativeProfileBridge').avatarRefForEmail(extras.email, name, 'full')?.uri || ''; } catch {}
      Promise.resolve(PP.openProfilePhotoGallery({ email: extras.email, name, photos, avatarUrl, index: Number(index) || 0, t }))
        .then((ok) => { if (!ok && typeof origAvatar === 'function') origAvatar(index); }, () => { if (typeof origAvatar === 'function') origAvatar(index); });
    };
  }
  out.hero = hero;

  // ── Publicações ──
  const posts = Array.isArray(extras.posts) ? extras.posts : [];
  const grid = [];
  const byKey = new Map();
  for (const p of posts) {
    const u = _thumb(p);
    if (!u || p.id == null) continue;
    const key = 'pp:' + String(p.id);
    if (byKey.has(key)) continue;
    byKey.set(key, p);
    grid.push({ key, u, a: /\/api\//.test(u) ? 1 : 0, video: _isVideo(p) });
    if (grid.length >= 600) break;
  }
  if (grid.length > 0) {
    const label = PP.ppT(t, 'posts');
    const count = extras.hasMore ? `${grid.length}+` : String(grid.length);
    const openProfile = () => { try { ctx.router?.push?.(`/u/${encodeURIComponent(extras.email)}`); } catch {} };
    const rows = Array.isArray(info.rows) ? info.rows.slice() : [];
    const at = rows.findIndex((r) => r && String(r.id) === 'starred');
    const postsRow = { id: 'pp_posts_all', sid: 'media', icon: 'image', title: label, val: count, onPress: openProfile };
    if (at >= 0) rows.splice(at + 1, 0, postsRow); else rows.push(postsRow);
    if (ctx.v6) {
      rows.push({ id: 'pp_posts', k: 'grid', sid: 'pp_posts', hd: label, title: label, val: count });
      out.gridMedia = grid;
      out.onMediaEnd = () => { try { extras.loadMore?.(); } catch {} };
    }
    out.rows = rows;
    const origMedia = info.onMediaPress;
    out.onMediaPress = (key) => {
      const k = String(key || '');
      if (!k.startsWith('pp:')) { if (typeof origMedia === 'function') origMedia(key); return; }
      const list = posts.filter((p) => p && p.id != null && byKey.has('pp:' + String(p.id)));
      const idx = list.findIndex((p) => 'pp:' + String(p.id) === k);
      if (idx < 0) { openProfile(); return; }
      let nmo = null;
      try { nmo = require('../../services/nativeMediaOpen'); } catch { nmo = null; }
      if (!nmo || !nmo.nativeMediaAlways?.() || !_postItem(list[idx], name)) { openProfile(); return; }
      Promise.resolve(nmo.openNativeMediaList({ list, index: idx, toItem: (p) => _postItem(p, name), t, allowShare: true, allowSave: true }))
        .then((sid) => { if (!sid) openProfile(); }, openProfile);
    };
  }
  return out;
}
