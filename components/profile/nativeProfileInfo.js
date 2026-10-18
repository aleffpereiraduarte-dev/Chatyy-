// components/profile/nativeProfileInfo.js — [2026-10-18 profile-native]
//
// Perfil estilo Telegram em NATIVO, reaproveitando a view ChatyyChatInfo
// (components/chat/NativeChatInfo.js, apiVersion ≥ 3) — sem uma 3ª tela
// nativa. Este arquivo só monta DESCRITORES (hero/rows/media/members); cada
// linha carrega o handler que o components/Profile.js já usa na versão JS
// (folhas, viewers, menus continuam os mesmos).
//
//   mode 'self' → Meu perfil (= Ajustes do Telegram): foto grande que encolhe
//                 para a barra / expande puxando (carrossel foto + capa),
//                 "Editar" na barra, celular / @usuário / recado, Definir foto,
//                 Editar perfil, Meu QR, Compartilhar, Meus status, Destaques,
//                 Seguidores/Seguindo, Publicações.
//                 [2026-10-18 settings-sub-native] SEM itens das Configurações
//                 (Chatyy Plus, Carteira, Favoritas, Aparelhos, categorias, Sair):
//                 moram só em /settings — perfil e Configurações não se repetem.
//   mode 'user' → perfil público de outra pessoa: Mensagem / Ligar / Vídeo /
//                 Seguir, celular / @usuário / recado / site, faixa de
//                 publicações, mídia compartilhada, grupos em comum (lista
//                 nativa de membros), compartilhar, mais opções, bloquear,
//                 denunciar.
// Ícones = nomes lógicos (CIText.symbol no iOS / CIText.drawable no Android).
import { initialsOf, gradientIndex } from '../chatlist/nativeAdapter';
import { avatarRefForEmail, avatarRefForUrl } from '../chat/NativeProfileBridge';

function _pic(ref, name, email) {
  const pic = { i: initialsOf(name, email), g: gradientIndex(name || email || '') };
  if (ref && ref.uri) {
    pic.u = ref.uri;
    if (ref.headers && (ref.headers.Authorization || ref.headers.authorization)) pic.a = 1;
  }
  return pic;
}

function _count(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
}

function _isVideo(it) {
  const ty = String(it?.media_type || it?.type || '');
  return ty === 'video' || ty === 'reel' || /video/.test(ty);
}

/**
 * ctx = {
 *   t, mode: 'self'|'user', identity, presenceText, social, actions, nickname,
 *   stories, highlights, posts, postsTotal, sharedMedia, commonChats,
 *   liveSessionId, diamonds (bool), planName, planDesc, abs(url) → absoluta,
 *   on: { back, edit, avatar(index, uri), stories, qr, share, follow, chat, call, video,
 *         email, followers(tab), grid(tab), post(item), group(chat), menu,
 *         block, report, live, gift, go(pathOrHref), logout, copy(text), link(url) }
 * }
 */
export function buildNativeProfileInfo(ctx) {
  const t = ctx.t || ((k) => k);
  const tr = (k, fb) => { const v = t(k); return v && v !== k ? v : fb; };
  const on = ctx.on || {};
  const id = ctx.identity || {};
  const self = ctx.mode === 'self';
  const email = String(id.email || '');
  const name = String((!self && ctx.nickname) || id.name || id.username || email.split('@')[0] || '');
  const username = String(id.username || '').replace(/^@/, '');
  const phone = String(id.phone || '').trim();
  const bio = String(id.bio || (self ? id.about : '') || '').trim();
  const website = String(id.website || '').trim();
  const social = ctx.social || {};
  const actions = ctx.actions || {};
  const abs = typeof ctx.abs === 'function' ? ctx.abs : (u) => u;

  // ── Fotos: avatar (tamanho cheio) + capa → carrossel da foto expandida ──
  const avatarRef = email ? avatarRefForEmail(email, name, 'full') : (id.avatar_url ? avatarRefForUrl(id.avatar_url, 'full') : null);
  const photos = [];
  const photoUris = [avatarRef && avatarRef.uri ? avatarRef.uri : ''];
  const cover = String(id.cover_url || '').trim();
  if (cover && avatarRef && avatarRef.uri) {
    const u = abs(cover);
    if (u) {
      photos.push({ u, a: /\/api\//.test(u) ? 1 : 0 });
      photoUris.push(u);
    }
  }
  if (Array.isArray(id.photos)) {
    for (const p of id.photos) {
      const raw = typeof p === 'string' ? p : (p && (p.url || p.u));
      const u = raw ? abs(String(raw)) : '';
      if (!u || photoUris.includes(u)) continue;
      photos.push({ u, a: /\/api\//.test(u) ? 1 : 0 });
      photoUris.push(u);
      if (photos.length >= 8) break;
    }
  }

  const hero = {
    title: name,
    sub: self ? email : (ctx.presenceText || (username ? '@' + username : '')),
    tile: _pic(avatarRef, name, email),
    badge: self ? 'camera' : '',
    photos,
    back: true,
    nav: self ? { key: 'edit', label: tr('common.edit', 'Editar'), onPress: () => on.edit?.() } : null,
    actions: [],
    onAvatarPress: (index) => {
      const i = Number(index) || 0;
      on.avatar?.(i, i > 0 ? (photoUris[i] || null) : null);
    },
  };
  if (!self) {
    if (actions.can_message) hero.actions.push({ key: 'msg', icon: 'message', label: tr('profile.message', 'Mensagem'), onPress: () => on.chat?.() });
    if (actions.can_call) {
      hero.actions.push({ key: 'call', icon: 'phone', label: tr('profile.call', 'Ligar'), onPress: () => on.call?.() });
      hero.actions.push({ key: 'video', icon: 'video', label: tr('profile.video', 'Vídeo'), onPress: () => on.video?.() });
    }
    if (!actions.can_message && actions.can_email) hero.actions.push({ key: 'email', icon: 'mail', label: tr('nativeProfile.email', 'E-mail'), onPress: () => on.email?.() });
    if (actions.can_follow) {
      const following = !!social.is_following;
      hero.actions.push({
        key: 'follow',
        icon: following ? 'check' : 'userPlus',
        label: following ? tr('profile.following', 'Seguindo') : (social.follows_me ? tr('profile.followBack', 'Seguir de volta') : tr('profile.follow', 'Seguir')),
        active: following,
        onPress: () => on.follow?.(),
      });
    }
    hero.actions = hero.actions.slice(0, 4);
  }

  const rows = [];
  // ── Informações (Telegram: valor grande + rótulo pequeno) ──
  if (phone) rows.push({ id: 'phone', k: 'about', sid: 'info', title: phone, sub: tr('nativeProfile.phone', 'Celular'), onPress: () => (self ? on.edit?.() : on.copy?.(phone)) });
  if (username) rows.push({ id: 'username', k: 'about', sid: 'info', title: '@' + username, sub: tr('nativeProfile.username', 'Nome de usuário'), onPress: () => (self ? on.edit?.() : on.copy?.('@' + username)) });
  if (bio || self) {
    rows.push({
      id: 'bio', k: 'about', sid: 'info', title: bio,
      val: bio ? '' : tr('nativeProfile.addBio', 'Adicionar recado'),
      sub: tr('nativeProfile.bio', 'Recado'),
      onPress: () => (self ? on.edit?.() : on.copy?.(bio)),
    });
  }
  if (website) rows.push({ id: 'site', k: 'about', sid: 'info', title: website, sub: tr('nativeProfile.website', 'Site'), onPress: () => on.link?.(website) });

  if (self) {
    rows.push({ id: 'setPhoto', k: 'a', sid: 'me', icon: 'camera', title: tr('nativeProfile.setPhoto', 'Definir foto de perfil'), onPress: () => on.edit?.() });
    rows.push({ id: 'edit', sid: 'me', icon: 'edit', title: tr('profile.edit', 'Editar perfil'), onPress: () => on.edit?.() });
    rows.push({ id: 'qr', sid: 'me', icon: 'qr', title: tr('nativeProfile.myQr', 'Meu QR code'), onPress: () => on.qr?.() });
    rows.push({ id: 'share', k: 'a', sid: 'me', icon: 'share', title: tr('profile.share', 'Compartilhar perfil'), onPress: () => on.share?.() });
  }

  // ── Status / destaques / seguidores ──
  const stories = Array.isArray(ctx.stories) ? ctx.stories : [];
  const highlights = Array.isArray(ctx.highlights) ? ctx.highlights : [];
  if (stories.length > 0) {
    rows.push({ id: 'status', sid: 'social', icon: 'status', title: self ? tr('nativeProfile.myStatus', 'Meus status') : tr('nativeProfile.status', 'Status'), val: _count(stories.length), onPress: () => on.stories?.() });
  }
  if (highlights.length > 0) {
    rows.push({ id: 'highlights', sid: 'social', icon: 'bookmark', title: tr('nativeProfile.highlights', 'Destaques'), val: _count(highlights.length), onPress: () => on.grid?.('posts') });
  }
  rows.push({ id: 'followers', sid: 'social', icon: 'followers', title: tr('profile.followers', 'Seguidores'), val: _count(social.followers_count) || '0', onPress: () => on.followers?.('followers') });
  rows.push({ id: 'following', sid: 'social', icon: 'users', title: tr('profile.following', 'Seguindo'), val: _count(social.following_count) || '0', onPress: () => on.followers?.('following') });
  const shared = Array.isArray(ctx.sharedMedia) ? ctx.sharedMedia : [];
  if (!self && shared.length > 0) {
    rows.push({ id: 'shared', sid: 'social', icon: 'image', title: tr('profile.sharedMedia', 'Mídia compartilhada'), val: _count(shared.length), onPress: () => on.grid?.('media') });
  }

  // ── Faixa de publicações (miniaturas nativas) ──
  const posts = Array.isArray(ctx.posts) ? ctx.posts : [];
  const media = [];
  const postByKey = new Map();
  for (const p of posts) {
    if (!p || p.__create) continue;
    const key = String(p.id || '');
    if (!key || postByKey.has(key)) continue;
    const raw = p.thumbnail || p.thumbnail_url || (Array.isArray(p.media_urls) ? p.media_urls[0] : '') || p.url || '';
    const u = raw ? abs(String(raw)) : '';
    if (!u) continue;
    postByKey.set(key, p);
    media.push({ key, u, a: /\/api\//.test(u) ? 1 : 0, video: _isVideo(p) });
    if (media.length >= 12) break;
  }
  if (media.length > 0) {
    rows.push({ id: 'posts', k: 'media', sid: 'posts', title: tr('nativeProfile.posts', 'Publicações'), val: _count(ctx.postsTotal || posts.length) });
  }

  // ── Outra pessoa: live, presente, grupos em comum, ações ──
  let members = null;
  if (!self) {
    if (ctx.liveSessionId) rows.push({ id: 'live', k: 'a', sid: 'live', icon: 'video', title: tr('live.watchingNow', 'Assistindo agora'), onPress: () => on.live?.() });
    if (ctx.diamonds) rows.push({ id: 'gift', k: 'a', sid: 'live', icon: 'gift', title: tr('gifts.sendGift', 'Enviar presente'), onPress: () => on.gift?.() });
    const groups = Array.isArray(ctx.commonChats) ? ctx.commonChats.filter((c) => c && c.id != null) : [];
    if (groups.length > 0) {
      rows.push({ id: 'groups', k: 'members', sid: 'groups' });
      members = {
        header: `${tr('profile.commonChats', 'Grupos em comum')} (${groups.length})`,
        items: groups.slice(0, 60).map((c) => {
          const nm = String(c.name || '');
          const ref = c.avatar ? avatarRefForUrl(c.avatar) : null;
          return { id: String(c.id), title: nm, tile: _pic(ref, nm, '') };
        }),
        total: groups.length,
        hasMore: false,
        loading: false,
        search: '',
        empty: '',
        actions: [],
      };
    }
    rows.push({ id: 'share', k: 'a', sid: 'acts', icon: 'share', title: tr('profile.share', 'Compartilhar perfil'), onPress: () => on.share?.() });
    rows.push({ id: 'more', k: 'a', sid: 'acts', icon: 'more', title: tr('nativeProfile.more', 'Mais opções'), onPress: () => on.menu?.() });
    rows.push({ id: 'block', k: 'a', sid: 'danger', dest: true, icon: 'block', title: tr('chat.blockUser', 'Bloquear usuário'), onPress: () => on.block?.() });
    rows.push({ id: 'report', k: 'a', sid: 'danger', dest: true, icon: 'flag', title: tr('chat.reportUser', 'Denunciar usuário'), onPress: () => on.report?.() });
  }

  return {
    hero,
    rows,
    media,
    members,
    onMediaPress: (key) => {
      if (!key) { on.grid?.('posts'); return; }
      const p = postByKey.get(String(key));
      if (p) on.post?.(p);
    },
    onMemberPress: (gid) => {
      const groups = Array.isArray(ctx.commonChats) ? ctx.commonChats : [];
      const c = groups.find((x) => x && String(x.id) === String(gid));
      if (c) on.group?.(c);
    },
    labels: { photo: tr('profile.viewPhoto', 'Ver foto') },
  };
}
