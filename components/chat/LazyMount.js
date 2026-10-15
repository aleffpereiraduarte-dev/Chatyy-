// [2026-10-15 conv-lite] Monta um sheet/modal da conversa SÓ na 1ª vez que ele abre.
//
// Antes, ~45 sheets/modais da tela de conversa ficavam montados FECHADOS desde a
// abertura (visible=false): cada um rodava seus hooks na montagem e re-renderizava
// a cada render da tela (dezenas por abertura), e os <Modal> inline montavam toda a
// árvore de elementos à toa. Agora:
//   <LazyMount when={showX}>{(v) => <Sheet visible={v} … />}</LazyMount>
// - nunca aberto  → não monta nada (nem avalia o JSX do filho);
// - 1ª abertura   → monta com visible=false e, no MESMO frame (layout effect,
//   antes da pintura), re-renderiza com visible=true — o filho vê a mesma
//   sequência fechado→aberto de antes (animação de entrada, efeitos [visible]);
// - depois        → fica montado para sempre (fechar/reabrir = igual a antes,
//   inclusive animação de saída e estado interno).
import { useLayoutEffect, useRef, useState } from 'react';

export default function LazyMount({ when, children }) {
  const everRef = useRef(false);
  const [armed, setArmed] = useState(false);
  if (when) everRef.current = true;
  useLayoutEffect(() => {
    if (everRef.current && !armed) setArmed(true);
  });
  if (!everRef.current) return null;
  return children(armed ? when : false);
}
