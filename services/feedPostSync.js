// [2026-10-21 feed-like-sync] Curtida feita DENTRO de um FeedPost (estado local) não
// chegava à lista pai: rolar (virtualização desmonta a linha) e voltar repintava o
// valor antigo do array `posts`. Bus mínimo: o FeedPost publica o estado de curtida
// (otimista e reconciliado com o servidor) e quem guarda a lista (ChatFeedTab) aplica
// no item. Sem deps; ouvintes com erro não derrubam os outros.
//
//   emitFeedLike(postId, liked, count)
//   const off = onFeedLike(({ id, liked, count }) => …); off();
const _listeners = new Set();

export function emitFeedLike(postId, liked, count) {
  if (postId == null) return;
  const ev = { id: String(postId), liked: !!liked, count: Math.max(0, Number(count) || 0) };
  _listeners.forEach((fn) => { try { fn(ev); } catch {} });
}

export function onFeedLike(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

// Patch puro de um post com o evento (todas as variantes de campo que o feed lê).
export function applyFeedLikeToPost(p, ev) {
  if (!p || !ev || String(p.id) !== ev.id) return p;
  const cur = Number(p.like_count ?? p.likes_count ?? p.likes) || 0;
  if (!!(p.user_liked ?? p.liked_by_me) === ev.liked && cur === ev.count) return p;
  const next = { ...p, user_liked: ev.liked, liked_by_me: ev.liked, like_count: ev.count, likes_count: ev.count };
  if (typeof p.likes === 'number') next.likes = ev.count;
  return next;
}
