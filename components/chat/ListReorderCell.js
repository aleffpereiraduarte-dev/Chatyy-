// [2026-10-20 tg-list-anim] Lista JS de conversas no iOS (iPad / reserva quando a
// lista nativa falha): reordenar (mensagem nova sobe a conversa, fixar, arquivar,
// apagar) desliza as linhas até o lugar novo SEM piscar.
//
// Antes: LayoutAnimation (global, próximo commit do Fabric) — no iOS ficava
// desligado no WS (piscava com a reciclagem da FlashList) e nas ações animava
// qualquer coisa que mudasse no mesmo commit.
// Agora: CellRendererComponent = Animated.View do Reanimated com
// layout={LinearTransition} → só a célula que MUDOU de posição anima, na UI thread.
//   - maxItemsInRecyclePool={0} (na lista): célula nunca troca de conversa; quem sai
//     da tela desmonta → nenhuma célula "voa" ao reciclar durante a rolagem.
//   - a transição só é ligada depois da 1ª pintura assentada (armListReorderAnim):
//     a correção estimativa→medida do 1º layout não anima.
//   - Reduzir Movimento: o Reanimated respeita a preferência do sistema.
// Kill: globalThis.__chatyy_list_reorder_anim = false (volta ao comportamento antigo).
import React, { useSyncExternalStore } from 'react';
import { Platform, View } from 'react-native';

let RA = null;
if (Platform.OS === 'ios') {
  try { RA = require('react-native-reanimated'); } catch {}
}
const OK = !!(RA && RA.default && RA.default.View && RA.LinearTransition);

export function listReorderAnimOn() {
  return OK && globalThis.__chatyy_list_reorder_anim !== false;
}

// Estado global "transição armada" (uma lista JS de conversas por vez).
let _armed = false;
const _subs = new Set();
const _get = () => _armed;
const _sub = (fn) => { _subs.add(fn); return () => _subs.delete(fn); };
function _set(v) {
  if (_armed === v) return;
  _armed = v;
  _subs.forEach((fn) => { try { fn(); } catch {} });
}
let _armTimer = null;
/** Chamar no onLoad da lista: arma a transição depois que o 1º layout assentou. */
export function armListReorderAnim(delayMs = 600) {
  if (!listReorderAnimOn()) return;
  if (_armTimer) clearTimeout(_armTimer);
  _armTimer = setTimeout(() => { _armTimer = null; _set(true); }, delayMs);
}
export function disarmListReorderAnim() {
  if (_armTimer) { clearTimeout(_armTimer); _armTimer = null; }
  _set(false);
}
/** true = as células já animam a reordenação (não chamar LayoutAnimation junto). */
export function listReorderAnimArmed() { return _armed && listReorderAnimOn(); }

let _transition = null;
function _tr() {
  if (_transition) return _transition;
  try {
    const E = RA.Easing;
    _transition = RA.LinearTransition.duration(260).easing(E && E.bezier ? E.bezier(0.2, 0.8, 0.2, 1) : undefined);
  } catch {
    _transition = RA.LinearTransition;
  }
  return _transition;
}

// FlashList passa ref (medição), onLayout, style (position/top/left/width) e index.
export const ListReorderCell = React.forwardRef(function ListReorderCell(props, ref) {
  const armed = useSyncExternalStore(_sub, _get, _get);
  if (!OK) return <View ref={ref} {...props} />;
  const AV = RA.default.View;
  return <AV ref={ref} {...props} layout={armed ? _tr() : undefined} />;
});
