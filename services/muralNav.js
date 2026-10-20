// services/muralNav.js — [mural 2026-10-20] navegação do "Perfil com Mural".
//
// Ponto ÚNICO que o perfil (components/profile/tg/*) e os compositores antigos
// chamam para abrir um post, os comentários ou o compositor
// (mockup preview-2026/perfil.html, telas 2, 3, 5 e 6):
//
//   openPost(post | id, { comments?, index? })  → rota /mural/post/<id>
//       foto  → components/mural/PostViewer (tela 2: fundo preto, carrossel,
//               toque duplo curte, pinça)
//       texto → components/mural/TextPostView (tela 3: cartão + comentários)
//       Passe o OBJETO do post (formato Post do API.md / feed antigo) para pintar
//       no 1º quadro, sem esperar o post_get.
//   openComments(post | id, { post? })  → components/mural/CommentsSheet (tela 6)
//       Se a tela atual montou <MuralCommentsHost /> (components/mural/
//       CommentsSheet.js) a folha sobe ali mesmo; senão abre o post com a folha
//       já aberta.
//   openComposer({ mode?: 'text'|'photo', pick?: 'library'|'camera', from?, text?, audience?, items? })
//       → components/mural/PostComposer (tela 5) em /photo-new?mural=1.
//
// Kill switches (OTA):
//   globalThis.__chatyy_mural_composer = false → compositor antigo (/photo-new legado)
//   globalThis.__chatyy_mural_viewer   = false → post abre no /feed/<id> antigo
// registerMuralNav({...}) continua valendo para quem quiser sobrepor (parcial vale).
// Nenhuma função lança: falhou → devolve false.
import { Platform } from 'react-native';

const _impl = { openPost: null, openComments: null, openComposer: null };
const _subs = new Set();

/** Sobrepõe a implementação (parcial vale). Devolve o "desfazer". */
export function registerMuralNav(impl) {
  if (!impl || typeof impl !== 'object') return () => {};
  const prev = { ..._impl };
  for (const k of Object.keys(_impl)) if (typeof impl[k] === 'function') _impl[k] = impl[k];
  for (const fn of Array.from(_subs)) { try { fn(); } catch {} }
  return () => { Object.assign(_impl, prev); };
}

export function subscribeMuralNav(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => _subs.delete(fn);
}

export function isMuralComposerOn() {
  try { if (globalThis.__chatyy_mural_composer === false) return false; } catch {}
  return true;
}
export function isMuralViewerOn() {
  try { if (globalThis.__chatyy_mural_viewer === false) return false; } catch {}
  return true;
}

function _router(opts) {
  if (opts && opts.router) return opts.router;
  try { return require('expo-router').router || null; } catch { return null; }
}
function _store() { try { return require('./muralStore'); } catch { return null; } }

function _postId(post) {
  if (post == null) return '';
  const id = typeof post === 'object' ? (post.id != null ? post.id : post.post_id) : post;
  if (id == null || id === '') return '';
  const s = String(id);
  return s.startsWith('pp:') ? '' : s; // otimista (fila) ainda sem id do servidor
}

/** Abre o post (foto → visualizador escuro; texto → cartão grande). */
export function openPost(post, opts = {}) {
  try { if (_impl.openPost) return _impl.openPost(post, opts) !== false; } catch {}
  const id = _postId(post);
  const r = _router(opts);
  if (!id || !r) return false;
  if (!isMuralViewerOn()) {
    try { r.push(`/feed/${encodeURIComponent(id)}`); return true; } catch { return false; }
  }
  try { if (post && typeof post === 'object') _store()?.primePost(post); } catch {}
  const params = { id };
  if (opts.comments || opts.focusComments) params.comments = '1';
  if (opts.index != null) params.index = String(opts.index);
  try {
    if (opts.replace) r.replace({ pathname: '/mural/post/[id]', params });
    else r.push({ pathname: '/mural/post/[id]', params });
    return true;
  } catch { return false; }
}

// ─── Folha de comentários ────────────────────────────────────────────────────
const _hosts = [];
/** Usado por <MuralCommentsHost/>: o último montado (tela em foco) recebe os pedidos. */
export function registerCommentsHost(fn) {
  if (typeof fn !== 'function') return () => {};
  _hosts.push(fn);
  return () => { const i = _hosts.lastIndexOf(fn); if (i >= 0) _hosts.splice(i, 1); };
}

/** Folha de comentários do post. */
export function openComments(post, opts = {}) {
  try { if (_impl.openComments) return _impl.openComments(post, opts) !== false; } catch {}
  const id = _postId(post);
  if (!id) return false;
  if (!isMuralViewerOn()) return openPost(post, opts);
  const full = (post && typeof post === 'object') ? post : (opts.post || null);
  try { if (full) _store()?.primePost(full); } catch {}
  for (let i = _hosts.length - 1; i >= 0; i--) {
    try { if (_hosts[i](id, opts) !== false) return true; } catch {}
  }
  return openPost(full || id, { ...opts, comments: true });
}

/** Compositor ("No que você está pensando?" / Publicar). */
export function openComposer(opts = {}) {
  try { if (_impl.openComposer) return _impl.openComposer(opts) !== false; } catch {}
  const r = _router(opts);
  if (!r) return false;
  let pc = null;
  try { pc = require('./profilePostComposer'); } catch { pc = null; }
  if (!isMuralComposerOn()) {
    try { return pc.openPostComposer(r, { pick: Platform.OS === 'web' ? '' : (opts.pick || 'library'), from: opts.from || 'profile', items: opts.items || null }); } catch { return false; }
  }
  const q = ['mural=1'];
  // itens já escolhidos (Fotos / compartilhar) → entregues em memória
  if (Array.isArray(opts.items) && opts.items.length && pc?.stashPendingPostItems) pc.stashPendingPostItems(opts.items);
  else if (opts.pick === 'library' || opts.pick === 'camera') q.push(`pick=${opts.pick}`);
  else if (opts.mode === 'photo' && Platform.OS !== 'web') q.push('pick=library');
  if (opts.from) q.push(`from=${encodeURIComponent(opts.from)}`);
  if (opts.text) q.push(`text=${encodeURIComponent(String(opts.text).slice(0, 1000))}`);
  if (opts.audience) q.push(`audience=${encodeURIComponent(opts.audience)}`);
  try { r.push(`/photo-new?${q.join('&')}`); return true; } catch { return false; }
}

export function hasMuralImpl(name) {
  if (_impl[name]) return true;
  if (name === 'openComposer') return isMuralComposerOn();
  return isMuralViewerOn();
}

export default { registerMuralNav, subscribeMuralNav, openPost, openComments, openComposer, hasMuralImpl, registerCommentsHost, isMuralComposerOn, isMuralViewerOn };
