// [2026-10-14 perf-web] Pré-aquecimento de rotas assíncronas na WEB.
//
// Por quê: com asyncRoutes, cada tela do expo-router é um React.lazy dentro de
// <Suspense>. Mesmo com o chunk já baixado/em cache, a 1ª renderização da rota
// SEMPRE suspende (o factory é async) → o React 19 mostra o fallback e segura a
// revelação do conteúdo por ≥300 ms (FALLBACK_THROTTLE_MS). Medido no boot
// morno: a lista ficava pronta ~635 ms mas só era commitada ~930 ms; abrir
// conversa/perfil pagava o mesmo pedágio. A navegação do React Navigation 7 é
// useSyncExternalStore (render síncrono), então startTransition não ajuda.
//
// Como: iniciamos o React.lazy da rota ANTES de ela renderizar. Chamamos o
// getQualifiedRouteComponent(node) do expo-router (mesma função e mesmo cache
// por nó que o navigator usa) com um React.lazy instrumentado só durante a
// chamada, capturamos o objeto lazy e disparamos o _init dele. Quando o import
// resolve, o payload fica "resolved" → a rota renderiza sem suspender, sem
// fallback, sem os 300 ms. Se algo mudar no expo-router, tudo cai no try/catch e
// o comportamento é o de antes (só perde o ganho). No-op fora da web.
import { Platform } from 'react-native';

const _done = new Set();

function _findNode(root, name) {
  const kids = (root && root.children) || [];
  for (const n of kids) if (n && n.route === name) return n;
  return null;
}

export function prewarmWebRoutes(names) {
  if (Platform.OS !== 'web' || !Array.isArray(names)) return;
  let React, store, getQualifiedRouteComponent;
  try {
    React = require('react');
    store = require('expo-router/build/global-state/router-store').store;
    getQualifiedRouteComponent = require('expo-router/build/useScreens').getQualifiedRouteComponent;
  } catch { return; }
  if (!React || typeof React.lazy !== 'function' || typeof getQualifiedRouteComponent !== 'function') return;
  let root = null;
  try { root = store && store.routeNode; } catch {}
  if (!root) return;
  for (const name of names) {
    if (_done.has(name)) continue;
    _done.add(name);
    const node = _findNode(root, name);
    if (!node) continue;
    const origLazy = React.lazy;
    let captured = null;
    try {
      React.lazy = function (factory) { const l = origLazy(factory); captured = l; return l; };
      getQualifiedRouteComponent(node); // já em cache (rota renderizada) → não cria lazy → nada a fazer
    } catch {
      captured = null;
    } finally {
      React.lazy = origLazy;
    }
    _kick(captured);
  }
}

// Dispara o _init de um React.lazy ainda não iniciado. Pendente → o lazy guarda a
// promise e se marca resolvido sozinho. FALHOU (offline, deploy novo) → devolve o
// lazy ao estado "não iniciado" p/ que a 1ª render real tente o import de novo,
// exatamente como antes do pré-aquecimento (nunca deixa um erro "grudado").
function _kick(l) {
  const pl = l && l._payload;
  if (!pl || typeof l._init !== 'function' || pl._status !== -1) return;
  const factory = pl._result;
  try {
    l._init(pl);
  } catch (p) {
    if (p && typeof p.then === 'function') {
      p.then(() => {}, () => { try { if (pl._status === 2) { pl._status = -1; pl._result = factory; } } catch {} });
    }
  }
}

// [2026-10-14 perf] Mesmo pedágio vale p/ qualquer React.lazy (web E nativo: o
// import() devolve promise mesmo com o módulo no bundle) — ex.: abas lazy da home
// (Ligações/Reels) mostravam o fallback e só revelavam ≥300 ms depois no 1º toque.
// Dispara o _init dos lazies indicados (idempotente; falha volta ao estado inicial).
export function prewarmLazyComponents(lazies) {
  if (!Array.isArray(lazies)) return;
  for (const l of lazies) _kick(l);
}

// [2026-10-14 perf] Promise que resolve quando o React.lazy está pronto (dispara o
// import se ainda não começou). Usado p/ "destravar" um <Suspense> que ficou no
// fallback: reproduzido na web (prod) — após recarregar a página, a aba Ligações
// ficava no skeleton >15 s; o retry do React 19 (throttle de 300 ms) era perdido
// no meio de outras atualizações. Quem chama faz um setState ao resolver → render
// normal (não-retry) do pai → o lazy já resolvido entra sem suspender.
export function whenLazyReady(l) {
  const pl = l && l._payload;
  if (!pl || typeof l._init !== 'function') return Promise.resolve(false);
  if (pl._status === 1) return Promise.resolve(true);
  _kick(l);
  const p = pl._status === 0 ? pl._result : null;
  if (!p || typeof p.then !== 'function') return Promise.resolve(pl._status === 1);
  return p.then(() => pl._status === 1, () => false);
}
