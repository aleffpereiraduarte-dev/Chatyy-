// [2026-10-17 nav-once] Navegação idempotente — "toquei 2x e abriu 2 janelas".
//
// A trava antiga (650 ms por TEMPO, services/navGuard / settings.js) não
// segurava quando a tela de destino demorava > 650 ms p/ montar: o 1º toque
// "não respondia", o usuário tocava de novo e empilhava a 2ª cópia. Aqui:
//   1) trava EM VOO de nível de módulo: um push por vez. Liberada quando a tela
//      empurrada monta/foca (releaseNavLock / useReleaseNavLockOnFocus) ou,
//      no pior caso, depois de LOCK_MS;
//   2) nunca empurra a MESMA rota (nome + params pedidos) que já está no topo
//      do stack — cobre o toque que chega durante a animação do push (a tela
//      de baixo ainda está visível e tocável).
// Fora isso é um router.push normal (string ou { pathname, params }).
import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';

const LOCK_MS = 1200;
// Depois que a tela de destino focou, segura mais um pouco: o 2º toque de um
// toque duplo costuma chegar ~100-250 ms depois do 1º.
const HOLD_AFTER_FOCUS_MS = 350;

let _inflight = null; // { key, until }

function _parse(href) {
  if (!href) return { name: '', params: {} };
  if (typeof href === 'string') {
    const [path, qs] = href.split('?');
    const params = {};
    if (qs) {
      for (const part of qs.split('&')) {
        if (!part) continue;
        const i = part.indexOf('=');
        const k = decodeURIComponent(i >= 0 ? part.slice(0, i) : part);
        const v = i >= 0 ? decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' ')) : '';
        params[k] = v;
      }
    }
    return { name: String(path || '').replace(/^\/+/, '').replace(/\/+$/, ''), params };
  }
  const p = href.params && typeof href.params === 'object' ? href.params : {};
  return { name: String(href.pathname || '').replace(/^\/+/, '').replace(/\/+$/, ''), params: p };
}

export function navKey(href) {
  const { name, params } = _parse(href);
  const keys = Object.keys(params).filter((k) => params[k] != null && params[k] !== '').sort();
  return name + (keys.length ? '?' + keys.map((k) => k + '=' + String(params[k])).join('&') : '');
}

// Rota focada mais funda do navegador raiz (estado interno do expo-router;
// qualquer falha → null e a checagem "já está no topo" é pulada).
function _topRoute() {
  try {
    const store = require('expo-router/build/global-state/router-store').store;
    const ref = store && store.navigationRef && store.navigationRef.current;
    if (!ref || !ref.isReady || !ref.isReady()) return null;
    let st = ref.getRootState();
    let route = null;
    while (st && Array.isArray(st.routes) && st.routes.length) {
      route = st.routes[typeof st.index === 'number' ? st.index : st.routes.length - 1];
      st = route && route.state;
    }
    return route || null;
  } catch {
    return null;
  }
}

/** true se a rota do topo já é `href` (mesmo nome e os params pedidos iguais). */
export function isOnTop(href) {
  const top = _topRoute();
  if (!top) return false;
  const { name, params } = _parse(href);
  if (!name) return false;
  // expo-router: nome da rota = caminho do arquivo ('settings-section', 'u/[username]'…).
  if (String(top.name || '') !== name) return false;
  const tp = top.params || {};
  for (const k of Object.keys(params)) {
    const want = params[k];
    if (want == null || want === '') continue;
    if (String(tp[k] ?? '') !== String(want)) return false;
  }
  return true;
}

/**
 * router.push idempotente. Retorna true se navegou.
 * opts.lockMs — trava em voo (padrão 1200 ms).
 */
export function pushOnce(router, href, opts) {
  const now = Date.now();
  if (_inflight && now < _inflight.until) return false;
  if (isOnTop(href)) return false;
  _inflight = { key: navKey(href), until: now + ((opts && opts.lockMs) || LOCK_MS) };
  try {
    router.push(href);
  } catch (e) {
    _inflight = null;
    throw e;
  }
  return true;
}

/** Tela de destino montou/focou: libera a trava (após uma folga curta). */
export function releaseNavLock() {
  if (!_inflight) return;
  const until = Date.now() + HOLD_AFTER_FOCUS_MS;
  if (until < _inflight.until) _inflight = { ..._inflight, until };
}

/** Hook p/ telas de destino: libera a trava quando a tela foca. */
export function useReleaseNavLockOnFocus() {
  const cb = useCallback(() => { releaseNavLock(); return undefined; }, []);
  useFocusEffect(cb);
}
