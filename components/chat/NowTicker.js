// [2026-10-15 conv-lite] Relógio LOCAL de um trecho da tela de conversa.
// Antes o menu de toque longo fazia setState na TELA INTEIRA a cada 1 s
// (contagem "Apagar para todos · disponível por X") enquanto ficava aberto.
// Agora só o filho re-renderiza:  <NowTicker everyMs={1000}>{(now) => …}</NowTicker>
import { useEffect, useState } from 'react';

export default function NowTicker({ everyMs = 1000, children }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return children(now);
}
